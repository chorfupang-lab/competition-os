import { sql } from "kysely";
import {
  fallbackFeedback,
  suggestedFraction,
  validateFeedback,
  type ContentItemData,
  type FeedbackFacts,
  type ItemBody,
  type Locale,
} from "@cos/core";
import { SYSTEM_PLATFORM, systemTenantContext, withContext, type Attempt, type DB, type Tx } from "@cos/db";
import type { BlobStore } from "../ai/blob-store.ts";
import type { FeedbackProvider, PronunciationProvider } from "../ai/providers.ts";
import { audit } from "./audit.ts";
import { loadPool, rescoreAttempt } from "./runtime.ts";

export interface AiDeps {
  blobs: BlobStore;
  pronunciation: PronunciationProvider;
  feedback: FeedbackProvider;
  pronunciationMicrosPerMinute: number;
}

/** Queue a job once per dedupe key (re-submitting the same recording is a no-op). */
export async function enqueueAiJob(tx: Tx, job: { tenantId: string; competitionId: string | null; kind: "pronunciation" | "feedback"; dedupeKey: string; payload: Record<string, unknown> }) {
  await sql`
    insert into ai_jobs (tenant_id, competition_id, kind, dedupe_key, payload)
    values (${job.tenantId}, ${job.competitionId}, ${job.kind}, ${job.dedupeKey}, ${JSON.stringify(job.payload)})
    on conflict (dedupe_key) do nothing`.execute(tx);
}

const backoffMs = (attempt: number) => Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));

/** Run due AI jobs. Failures retry with exponential backoff; the participant is never blocked. */
export async function runAiJobs(db: DB, ai: AiDeps, limit = 20): Promise<{ succeeded: number; retried: number; failed: number }> {
  const claimed = await withContext(db, SYSTEM_PLATFORM, async (tx) => {
    const { rows } = await sql<{ id: string; tenant_id: string; kind: string }>`select * from app.claim_ai_jobs(${limit}, 300)`.execute(tx);
    return rows;
  });
  const report = { succeeded: 0, retried: 0, failed: 0 };
  for (const job of claimed) {
    try {
      const outcome = job.kind === "pronunciation" ? await processPronunciation(db, ai, job.id, job.tenant_id) : await processFeedback(db, ai, job.id, job.tenant_id);
      await withContext(db, systemTenantContext(job.tenant_id), (tx) =>
        tx.updateTable("ai_jobs").set({ status: "succeeded", finished_at: new Date(), locked_until: null, result: JSON.stringify(outcome.result), provider: outcome.provider, model: outcome.model, last_error: null }).where("id", "=", job.id).execute(),
      );
      report.succeeded++;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const permanent = err instanceof PermanentJobError;
      const row = await withContext(db, systemTenantContext(job.tenant_id), async (tx) => {
        const j = await tx.selectFrom("ai_jobs").select(["attempts", "max_attempts"]).where("id", "=", job.id).executeTakeFirstOrThrow();
        const giveUp = permanent || j.attempts >= j.max_attempts;
        await tx
          .updateTable("ai_jobs")
          .set(giveUp
            ? { status: "failed", last_error: message, locked_until: null, finished_at: new Date() }
            : { status: "pending", last_error: message, locked_until: null, run_after: new Date(Date.now() + backoffMs(j.attempts)) })
          .where("id", "=", job.id)
          .execute();
        return giveUp;
      });
      if (row) report.failed++;
      else report.retried++;
    }
  }
  return report;
}

export class PermanentJobError extends Error {}

interface Outcome {
  result: Record<string, unknown>;
  provider: string;
  model: string | null;
}

// ---------------------------------------------------------------- pronunciation

async function processPronunciation(db: DB, ai: AiDeps, jobId: string, tenantId: string): Promise<Outcome> {
  const ctx = systemTenantContext(tenantId);
  const prep = await withContext(db, ctx, async (tx) => {
    const job = await tx.selectFrom("ai_jobs").select(["payload", "competition_id"]).where("id", "=", jobId).executeTakeFirstOrThrow();
    const { recordingId } = job.payload as { recordingId: string };
    const rec = await tx.selectFrom("recordings").selectAll().where("id", "=", recordingId).executeTakeFirst();
    if (!rec || rec.status !== "stored") throw new PermanentJobError("recording_unavailable");
    let contentVersionId: string;
    let retentionDays = 0;
    let attempt: Attempt | null = null;
    if (rec.attempt_id) {
      attempt = (await tx.selectFrom("attempts").selectAll().where("id", "=", rec.attempt_id).executeTakeFirstOrThrow()) as Attempt;
      contentVersionId = attempt.content_version_id;
      retentionDays = (await tx.selectFrom("competitions").select("voice_retention_days").where("id", "=", attempt.competition_id).executeTakeFirstOrThrow()).voice_retention_days;
    } else {
      contentVersionId = (await tx.selectFrom("practice_sets").select("content_version_id").where("id", "=", rec.practice_set_id!).executeTakeFirstOrThrow()).content_version_id;
    }
    const item = (await loadPool(tx, contentVersionId, [rec.item_id])).get(rec.item_id)?.snapshot.item;
    if (!item || item.contentType !== "pronunciation") throw new PermanentJobError("not_a_pronunciation_item");
    return { rec, attempt, item: item as ContentItemData, retentionDays, competitionId: job.competition_id };
  });

  // Network call outside any transaction.
  const audio = await ai.blobs.get(prep.rec.storage_key);
  const body = prep.item.body as ItemBody<"pronunciation">;
  const result = await ai.pronunciation.assess({ audio, mimeType: prep.rec.mime_type, targetText: body.targetText, speechLanguage: body.speechLanguage, romanization: body.romanization ?? null, aspects: body.aspects });
  const suggested = suggestedFraction(result.assessment, body.aspects);

  await withContext(db, ctx, async (tx) => {
    const assessment = await tx
      .insertInto("pronunciation_assessments")
      .values({
        tenant_id: tenantId,
        recording_id: prep.rec.id,
        attempt_id: prep.rec.attempt_id,
        practice_set_id: prep.rec.practice_set_id,
        competition_id: prep.attempt?.competition_id ?? null,
        round_id: prep.attempt?.round_id ?? null,
        group_id: prep.attempt?.group_id ?? null,
        item_id: prep.rec.item_id,
        student_id: prep.rec.student_id,
        speech_language: body.speechLanguage,
        provider: result.provider,
        model: result.model,
        overall: result.assessment.overall,
        aspects: JSON.stringify(result.assessment.aspects),
        units: JSON.stringify(result.assessment.units),
        suggested_fraction: suggested,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const aiGrade = { outcome: "pending_ai", fraction: null, ai: { assessmentId: assessment.id, suggestedFraction: suggested, overall: result.assessment.overall } };

    if (prep.attempt) {
      // Only if the answer still points at this recording (the student may have re-recorded).
      const updated = await tx
        .updateTable("attempt_answers")
        .set({ grade: JSON.stringify(aiGrade) })
        .where("attempt_id", "=", prep.attempt.id)
        .where("item_id", "=", prep.rec.item_id)
        .where(sql<boolean>`response->>'recordingId' = ${prep.rec.id}`)
        .executeTakeFirst();
      const current = (await tx.selectFrom("attempts").selectAll().where("id", "=", prep.attempt.id).forUpdate().executeTakeFirstOrThrow()) as Attempt;
      if (Number(updated.numUpdatedRows) && current.status === "submitted") await rescoreAttempt(tx, current, "AI pronunciation assessment received", null);
    } else {
      const set = await tx.selectFrom("practice_sets").select(["grades"]).where("id", "=", prep.rec.practice_set_id!).forUpdate().executeTakeFirstOrThrow();
      const grades = { ...(set.grades as Record<string, unknown>), [prep.rec.item_id]: { outcome: suggested >= 1 ? "correct" : suggested <= 0 ? "incorrect" : "partial", fraction: suggested, ai: aiGrade.ai } };
      await tx.updateTable("practice_sets").set({ grades: JSON.stringify(grades) }).where("id", "=", prep.rec.practice_set_id!).execute();
    }

    // Retention: analyse, then delete raw voice unless the organizer keeps it.
    if (prep.retentionDays > 0) {
      await tx.updateTable("recordings").set({ retain_until: new Date(Date.now() + prep.retentionDays * 86_400_000) }).where("id", "=", prep.rec.id).execute();
    } else {
      await ai.blobs.delete(prep.rec.storage_key);
      await tx.updateTable("recordings").set({ status: "deleted", deleted_at: new Date(), deleted_reason: "analysed" }).where("id", "=", prep.rec.id).execute();
    }
    await tx
      .insertInto("ai_usage")
      .values({ tenant_id: tenantId, competition_id: prep.competitionId, job_id: jobId, kind: "pronunciation", provider: result.provider, model: result.model, units: JSON.stringify({ audioMs: result.audioMs }), cost_micros: Math.round((result.audioMs / 60_000) * ai.pronunciationMicrosPerMinute) })
      .execute();
  });
  return { result: { suggestedFraction: suggested, overall: result.assessment.overall }, provider: result.provider, model: result.model };
}

// ---------------------------------------------------------------- feedback

/**
 * The approved facts for one attempt or practice set: score, per-skill
 * results from the tenant's framework, and practice items from
 * practice-enabled banks only.
 */
export async function feedbackFacts(tx: Tx, target: { attemptId?: string; practiceSetId?: string }, locale: Locale): Promise<{ facts: FeedbackFacts; studentId: string; tenantId: string }> {
  const obs = await tx
    .selectFrom("skill_observations")
    .select(["skill_id", "correct", "total", "student_id", "tenant_id"])
    .where(target.attemptId ? "attempt_id" : "practice_set_id", "=", (target.attemptId ?? target.practiceSetId)!)
    .execute();
  let score: { totalScore?: number; maxScore?: number; accuracy?: number };
  let studentId: string;
  let tenantId: string;
  if (target.attemptId) {
    const a = await tx.selectFrom("attempts").select(["score", "student_id", "tenant_id"]).where("id", "=", target.attemptId).executeTakeFirstOrThrow();
    score = (a.score ?? {}) as typeof score;
    studentId = a.student_id;
    tenantId = a.tenant_id;
  } else {
    const p = await tx.selectFrom("practice_sets").select(["score", "student_id", "tenant_id"]).where("id", "=", target.practiceSetId!).executeTakeFirstOrThrow();
    score = (p.score ?? {}) as typeof score;
    studentId = p.student_id;
    tenantId = p.tenant_id;
  }
  const ids = obs.map((o) => o.skill_id);
  const { rows: labels } = ids.length
    ? await sql<{ id: string; name: string; name_i18n: Record<string, string> }>`select id, name, name_i18n from app.skill_labels(${ids}::uuid[])`.execute(tx)
    : { rows: [] };
  const nameOf = (id: string) => {
    const l = labels.find((x) => x.id === id);
    return l?.name_i18n?.[locale] ?? l?.name ?? "skill";
  };
  const perSkill = obs.map((o) => ({ id: o.skill_id, name: nameOf(o.skill_id), mastery: Number(o.correct) / Number(o.total), questions: Number(o.total) }));
  const strengths = perSkill.filter((s) => s.mastery >= 0.7).sort((a, b) => b.mastery - a.mastery).slice(0, 3);
  const weaknesses = perSkill.filter((s) => s.mastery < 0.7).sort((a, b) => a.mastery - b.mastery).slice(0, 3);
  const candidates = await practiceCandidates(tx, studentId, weaknesses.map((w) => w.id), 5);
  const student = await tx.selectFrom("students").select(["preferred_name", "given_name"]).where("id", "=", studentId).executeTakeFirst();
  return {
    studentId,
    tenantId,
    facts: {
      locale,
      firstName: student?.preferred_name ?? student?.given_name ?? null,
      accuracy: score.accuracy ?? 0,
      totalScore: score.totalScore ?? 0,
      maxScore: score.maxScore ?? 0,
      strengths: strengths.map(({ id, name, mastery }) => ({ id, name, mastery })),
      weaknesses: weaknesses.map(({ id, name, mastery }) => ({ id, name, mastery })),
      practiceCandidates: candidates,
    },
  };
}

/** Practice items for weak skills, from practice-enabled banks the student's organizers publish. */
export async function practiceCandidates(tx: Tx, studentId: string, skillIds: string[], limit: number) {
  const { rows } = await sql<{ tenant_id: string; version_id: string; item_id: string; external_key: string; content_type: string; skill_ids: string[] | null }>`
    select * from app.practice_pool(${studentId})`.execute(tx);
  const wanted = new Set(skillIds);
  const matching = rows.filter((r) => (r.skill_ids ?? []).some((s) => wanted.has(s)));
  return matching.slice(0, limit).map((r) => ({ id: r.item_id, label: r.external_key }));
}

async function processFeedback(db: DB, ai: AiDeps, jobId: string, tenantId: string): Promise<Outcome> {
  const ctx = systemTenantContext(tenantId);
  const prep = await withContext(db, ctx, async (tx) => {
    const job = await tx.selectFrom("ai_jobs").select(["payload", "competition_id"]).where("id", "=", jobId).executeTakeFirstOrThrow();
    const p = job.payload as { attemptId?: string; practiceSetId?: string; locale: Locale };
    return { p, competitionId: job.competition_id, ...(await feedbackFacts(tx, p, p.locale)) };
  });
  const gen = await ai.feedback.generate(prep.facts);
  const validated = gen.raw === null && gen.provider === "template"
    ? { source: "fallback" as const, feedback: fallbackFeedback(prep.facts), reasons: ["template"] }
    : validateFeedback(gen.raw, prep.facts);
  await withContext(db, ctx, async (tx) => {
    await tx
      .insertInto("ai_feedback")
      .values({
        tenant_id: tenantId,
        attempt_id: prep.p.attemptId ?? null,
        practice_set_id: prep.p.practiceSetId ?? null,
        student_id: prep.studentId,
        locale: prep.p.locale,
        source: validated.source,
        feedback: JSON.stringify(validated.feedback),
        reasons: JSON.stringify(validated.source === "fallback" ? validated.reasons : []),
        provider: gen.provider,
        model: gen.model,
      })
      .execute();
    if (gen.provider !== "template") {
      await tx
        .insertInto("ai_usage")
        .values({ tenant_id: tenantId, competition_id: prep.competitionId, job_id: jobId, kind: "feedback", provider: gen.provider, model: gen.model, units: JSON.stringify({ inputTokens: gen.inputTokens, outputTokens: gen.outputTokens }), cost_micros: gen.costMicros })
        .execute();
    }
    if (validated.source === "fallback" && gen.provider !== "template") {
      await audit(tx, null, { tenantId, actorUserId: null, action: "ai.feedback_rejected", targetType: prep.p.attemptId ? "attempt" : "practice_set", targetId: (prep.p.attemptId ?? prep.p.practiceSetId)!, after: { reasons: validated.reasons, provider: gen.provider, model: gen.model }, metadata: { via: "system" } });
    }
  });
  return { result: { source: validated.source }, provider: gen.provider, model: gen.model };
}

// ---------------------------------------------------------------- retention

/** Delete retained recordings whose retention period has ended. */
export async function sweepRecordings(db: DB, blobs: BlobStore): Promise<number> {
  const due = await withContext(db, SYSTEM_PLATFORM, async (tx) => (await sql<{ id: string; tenant_id: string }>`select * from app.expired_recordings(500)`.execute(tx)).rows);
  for (const r of due) {
    await withContext(db, systemTenantContext(r.tenant_id), async (tx) => {
      const rec = await tx.selectFrom("recordings").select(["storage_key", "status"]).where("id", "=", r.id).forUpdate().executeTakeFirst();
      if (!rec || rec.status !== "stored") return;
      await blobs.delete(rec.storage_key);
      await tx.updateTable("recordings").set({ status: "deleted", deleted_at: new Date(), deleted_reason: "retention_expired" }).where("id", "=", r.id).execute();
    });
  }
  return due.length;
}
