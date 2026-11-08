import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import {
  AppError,
  CompetitionConfigSchema,
  DEFAULT_SCORING_RULE,
  MIN_COHORT,
  QUESTION_TYPES,
  RoundGroupSchema,
  buildQuestionSet,
  compareToCohort,
  fallbackFeedback,
  gradeResponse,
  isLocale,
  masteryBySkill,
  participantView,
  scoreAttempt,
  strengthsAndWeaknesses,
  toGradedItem,
  type Locale,
  type QuestionRef,
  type Response as ItemResponse,
} from "@cos/core";
import { ANONYMOUS, systemTenantContext, withContext, type DbContext, type Tx } from "@cos/db";
import { enqueueAiJob, feedbackFacts, practiceCandidates } from "../lib/ai-jobs.ts";
import { requireAuth, type AuthInfo } from "../lib/auth.ts";
import { newId } from "../lib/crypto.ts";
import { closeIfExpired, loadPool, saveAnswers, touchSession } from "../lib/runtime.ts";
import { parse, zLocale, zUuid } from "../lib/validation.ts";
import { resultsVisibleNow } from "./catalog.ts";

const personal = (auth: AuthInfo): DbContext => ({ ...ANONYMOUS, userId: auth.userId });
const onBehalf = (tenantId: string, auth: AuthInfo): DbContext => ({ userId: auth.userId, tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] });

const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac"];
export const MAX_RECORDING_BYTES = 5 * 1024 * 1024;

/** The student must be me (student login) or my child. */
export async function requireMyStudent(tx: Tx, auth: AuthInfo, studentId: string) {
  const s = await tx
    .selectFrom("students")
    .select(["id", "given_name", "preferred_name", "primary_locale", "date_of_birth"])
    .where("id", "=", studentId)
    .where((eb) => eb.or([eb("user_id", "=", auth.userId), eb(eb.ref("id"), "in", eb.selectFrom("parent_children").select("student_id").where("parent_user_id", "=", auth.userId))]))
    .executeTakeFirst();
  if (!s) throw new AppError("NOT_FOUND", { field: "studentId" });
  return s;
}

/** Published, visible results for a student, oldest first. */
export async function familyResults(tx: Tx, studentId: string | null) {
  let q = tx.selectFrom("result_entries").selectAll();
  if (studentId) q = q.where("student_id", "=", studentId);
  const entries = await q.execute();
  const out = [];
  for (const e of entries) {
    const { rows } = await sql<{ round_id: string; group_id: string; competition_id: string; status: string; version_number: number; published_at: Date }>`select * from app.result_version_public(${e.result_version_id})`.execute(tx);
    const v = rows[0];
    if (!v || v.status !== "published") continue;
    const comp = await tx
      .selectFrom("competitions as c")
      .innerJoin("competition_versions as cv", "cv.id", "c.current_version_id")
      .select(["c.name", "c.tenant_id", "c.results_publication", "c.passport_comparisons", "cv.config"])
      .where("c.id", "=", v.competition_id)
      .executeTakeFirst();
    if (!comp) continue;
    const config = CompetitionConfigSchema.parse(comp.config);
    if (!resultsVisibleNow(comp.results_publication, config)) continue;
    out.push({ entry: e, version: v, competition: { name: comp.name, tenantId: comp.tenant_id, comparisons: comp.passport_comparisons }, roundName: config.rounds.find((r) => r.id === v.round_id)?.name ?? null });
  }
  return out.sort((a, b) => a.version.published_at.getTime() - b.version.published_at.getTime());
}

export async function passportRoutes(app: FastifyInstance): Promise<void> {
  const { db, ai } = app.deps;

  app.addContentTypeParser(AUDIO_TYPES, { parseAs: "buffer", bodyLimit: MAX_RECORDING_BYTES }, (_req, body, done) => done(null, body));

  // ================================================================ Learning Passport

  /**
   * One student's Learning Passport across every organizer: competition
   * history, skill profile and trends, pronunciation profile, privacy-safe
   * comparisons, weak areas and recommended practice.
   */
  app.get("/passport/:studentId", async (request) => {
    const auth = requireAuth(request);
    const { studentId } = parse(z.object({ studentId: zUuid }), request.params);
    const locale = (isLocale(request.locale) ? request.locale : "en") as Locale;
    return withContext(db, personal(auth), async (tx) => {
      const student = await requireMyStudent(tx, auth, studentId);
      const observations = await tx.selectFrom("skill_observations").selectAll().where("student_id", "=", studentId).orderBy("observed_at").execute();
      const ids = [...new Set(observations.map((o) => o.skill_id))];
      const { rows: labels } = ids.length
        ? await sql<{ id: string; key: string; name: string; name_i18n: Record<string, string>; framework_key: string; framework_name: string; tenant_id: string }>`select * from app.skill_labels(${ids}::uuid[])`.execute(tx)
        : { rows: [] };
      const label = new Map(labels.map((l) => [l.id, l]));
      const mastery = masteryBySkill(observations.map((o) => ({ skillId: o.skill_id, observedAt: o.observed_at.toISOString(), correct: Number(o.correct), total: Number(o.total), source: o.source })));
      const sw = strengthsAndWeaknesses(mastery);
      const skillView = (m: (typeof mastery)[number]) => {
        const l = label.get(m.skillId);
        return { skillId: m.skillId, key: l?.key ?? null, name: l?.name_i18n?.[locale] ?? l?.name ?? null, framework: l ? { key: l.framework_key, name: l.framework_name } : null, mastery: m.mastery, questions: m.questions, attempts: m.attempts, lastChange: m.lastChange, trend: m.trend };
      };

      // Competition history with configured, aggregated comparisons.
      const results = await familyResults(tx, studentId);
      const history = [];
      for (const [i, r] of results.entries()) {
        const score = r.entry.total_score === null ? null : Number(r.entry.total_score);
        const comparisons: Record<string, unknown> = {};
        if (score !== null) {
          const { rows } = await sql<{ cohort: number; average: string | null; at_or_below: number; age_cohort: number; age_average: string | null }>`select * from app.result_cohort_stats(${r.entry.result_version_id}, ${score}, ${studentId})`.execute(tx);
          const c = rows[0]!;
          const enough = c.cohort >= MIN_COHORT;
          if (r.competition.comparisons.includes("group_average")) comparisons.groupAverage = enough ? Math.round(Number(c.average) * 1000) / 1000 : null;
          if (r.competition.comparisons.includes("percentile")) comparisons.percentile = enough ? Math.round((c.at_or_below / c.cohort) * 100) : null;
          if (r.competition.comparisons.includes("age_benchmark")) comparisons.ageAverage = c.age_cohort >= MIN_COHORT ? Math.round(Number(c.age_average) * 1000) / 1000 : null;
          if (r.competition.comparisons.includes("previous_attempt")) {
            const prev = results.slice(0, i).reverse().find((p) => p.competition.tenantId === r.competition.tenantId && p.entry.total_score !== null);
            comparisons.previousScore = prev ? Number(prev.entry.total_score) : null;
          }
          comparisons.cohortSize = enough ? c.cohort : null;
        }
        history.push({
          competitionId: r.version.competition_id, competitionName: r.competition.name, roundId: r.version.round_id, roundName: r.roundName,
          publishedAt: r.version.published_at, totalScore: score, rank: r.entry.rank, qualified: r.entry.qualified, status: r.entry.status, comparisons,
        });
      }

      // Pronunciation: latest vs previous per speech language, with a group average when the cohort allows.
      const assessments = await tx.selectFrom("pronunciation_assessments").selectAll().where("student_id", "=", studentId).orderBy("created_at").execute();
      const byLanguage = new Map<string, typeof assessments>();
      for (const a of assessments) byLanguage.set(a.speech_language, [...(byLanguage.get(a.speech_language) ?? []), a]);
      const pronunciation = [];
      for (const [language, list] of byLanguage) {
        const latest = list[list.length - 1]!;
        const previous = list.length > 1 ? list[list.length - 2]! : null;
        let groupAverage = null;
        if (latest.competition_id && latest.round_id && latest.group_id) {
          const { rows } = await sql<{ cohort: number; aspects: Record<string, number>; overall: string | null }>`select * from app.pronunciation_cohort(${latest.competition_id}, ${latest.round_id}, ${latest.group_id})`.execute(tx);
          if (rows[0] && rows[0].cohort >= MIN_COHORT) groupAverage = { aspects: rows[0].aspects, overall: Number(rows[0].overall), cohortSize: rows[0].cohort };
        }
        pronunciation.push({
          speechLanguage: language,
          assessments: list.length,
          // Radar chart series: the student now, before, and the group.
          latest: { at: latest.created_at, overall: Number(latest.overall), aspects: latest.aspects },
          previous: previous ? { at: previous.created_at, overall: Number(previous.overall), aspects: previous.aspects } : null,
          groupAverage,
          trend: list.map((a) => ({ at: a.created_at, overall: Number(a.overall) })),
        });
      }

      const recommended = await practiceCandidates(tx, studentId, sw.weaknesses.map((w) => w.skillId), 5);
      return {
        student: { id: student.id, name: student.preferred_name ?? student.given_name },
        skills: mastery.map(skillView),
        strengths: sw.strengths.map(skillView),
        weaknesses: sw.weaknesses.map(skillView),
        history,
        pronunciation,
        recommendedPractice: recommended,
        notes: { comparisonsMinimumCohort: MIN_COHORT },
      };
    });
  });

  /**
   * Upload the recording for a pronunciation question in an official or
   * practice-round attempt. The answer is saved at once (so a disconnect never
   * loses it) and analysed asynchronously; the attempt continues meanwhile.
   */
  app.put("/attempts/:attemptId/recordings/:itemId", async (request) => {
    const auth = requireAuth(request);
    const { attemptId, itemId } = parse(z.object({ attemptId: zUuid, itemId: zUuid }), request.params);
    const h = parse(z.object({ "x-session-id": zUuid, "x-client-seq": z.coerce.number().int().min(1), "x-client-saved-at": z.iso.datetime({ offset: true }).optional() }).passthrough(), request.headers);
    const audio = requireAudio(request);
    const owned = await withContext(db, personal(auth), (tx) => tx.selectFrom("attempts").select(["tenant_id"]).where("id", "=", attemptId).executeTakeFirst());
    if (!owned) throw new AppError("NOT_FOUND");
    const now = new Date();
    return withContext(db, onBehalf(owned.tenant_id, auth), async (tx) => {
      const current = await tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).forUpdate().executeTakeFirstOrThrow();
      const attempt = await closeIfExpired(tx, request, current as never, now);
      if (attempt.status !== "in_progress") throw new AppError("CONFLICT", { reason: attempt.status === "paused" ? "attempt_paused" : "attempt_closed" });
      await touchSession(tx, attempt, h["x-session-id"], request.ip, now);
      if (!(attempt.question_set as QuestionRef[]).some((q) => q.itemId === itemId)) throw new AppError("NOT_FOUND", { field: "itemId" });
      const item = (await loadPool(tx, attempt.content_version_id, [itemId])).get(itemId)!.snapshot.item;
      if (item.contentType !== "pronunciation") throw new AppError("VALIDATION_FAILED", [{ path: "itemId", message: "not a pronunciation question" }]);
      const recordingId = newId();
      const saved = await saveAnswers(tx, attempt, h["x-session-id"], [{ itemId, response: { recordingId }, clientSeq: h["x-client-seq"], clientSavedAt: h["x-client-saved-at"] ?? null, timeSpentMs: 0 }], now);
      if (!saved.saved.length) return { recordingId: null, ...saved };
      const key = `recordings/${attempt.tenant_id}/attempts/${attemptId}/${recordingId}`;
      await ai.blobs.put(key, audio.data, audio.type);
      await tx.insertInto("recordings").values({ id: recordingId, tenant_id: attempt.tenant_id, attempt_id: attemptId, practice_set_id: null, item_id: itemId, student_id: attempt.student_id, storage_key: key, mime_type: audio.type, bytes: audio.data.length, retain_until: null, deleted_at: null, deleted_reason: null }).execute();
      await enqueueAiJob(tx, { tenantId: attempt.tenant_id, competitionId: attempt.competition_id, kind: "pronunciation", dedupeKey: `pronunciation:${recordingId}`, payload: { recordingId } });
      return { recordingId, status: "analysis_pending", ...saved };
    });
  });

  // ================================================================ practice

  /** Build a practice set for weak skills from practice-enabled banks. Never part of official results. */
  app.post("/practice-sets", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parse(z.object({ studentId: zUuid, skillIds: z.array(zUuid).max(20).optional(), size: z.number().int().min(1).max(50).default(10), locale: zLocale.optional() }), request.body);
    const student = await withContext(db, personal(auth), (tx) => requireMyStudent(tx, auth, body.studentId));
    const weak = body.skillIds ?? (await withContext(db, personal(auth), async (tx) => {
      const obs = await tx.selectFrom("skill_observations").selectAll().where("student_id", "=", body.studentId).execute();
      const m = masteryBySkill(obs.map((o) => ({ skillId: o.skill_id, observedAt: o.observed_at.toISOString(), correct: Number(o.correct), total: Number(o.total), source: o.source })));
      return strengthsAndWeaknesses(m, 1, 5).weaknesses.map((w) => w.skillId);
    }));
    const pool = await withContext(db, personal(auth), async (tx) =>
      (await sql<{ tenant_id: string; version_id: string; item_id: string; skill_ids: string[] | null }>`select tenant_id, version_id, item_id, skill_ids from app.practice_pool(${body.studentId})`.execute(tx)).rows,
    );
    if (!pool.length) throw new AppError("CONFLICT", { reason: "no_practice_content" });
    // The version with the most items for the target skills.
    const wanted = new Set(weak);
    const score = new Map<string, number>();
    for (const r of pool) if ((r.skill_ids ?? []).some((s) => wanted.has(s))) score.set(r.version_id, (score.get(r.version_id) ?? 0) + 1);
    const versionId = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? pool[0]!.version_id;
    const tenantId = pool.find((r) => r.version_id === versionId)!.tenant_id;
    const inVersion = pool.filter((r) => r.version_id === versionId);
    const targeted = inVersion.filter((r) => (r.skill_ids ?? []).some((s) => wanted.has(s))).map((r) => r.item_id);
    const id = newId();
    const set = await withContext(db, onBehalf(tenantId, auth), async (tx) => {
      const items = await loadPool(tx, versionId);
      const rg = RoundGroupSchema.parse({ groupId: id, questionCount: body.size, questionFormats: [...QUESTION_TYPES], content: { selection: "random_from_pool" } });
      const refs = buildQuestionSet([...items.values()].map((p) => p.pool), rg, id, { require: targeted.slice(0, body.size) });
      const locale = body.locale ?? (student.primary_locale && isLocale(student.primary_locale) ? student.primary_locale : request.locale);
      await tx
        .insertInto("practice_sets")
        .values({ id, tenant_id: tenantId, student_id: body.studentId, created_by_user_id: auth.userId, content_version_id: versionId, target_skill_ids: weak, locale, question_set: JSON.stringify(refs), score: null, submitted_at: null })
        .execute();
      return { refs, items, locale };
    });
    return reply.status(201).send({
      id,
      targetSkillIds: weak,
      questions: set.refs.map((ref) => {
        const p = set.items.get(ref.itemId)!;
        return participantView(p.snapshot.item, ref, p.snapshot.translations[set.locale] ?? null);
      }),
    });
  });

  async function myPracticeSet(auth: AuthInfo, setId: string) {
    const s = await withContext(db, personal(auth), (tx) => tx.selectFrom("practice_sets").selectAll().where("id", "=", setId).executeTakeFirst());
    if (!s) throw new AppError("NOT_FOUND");
    return s;
  }

  app.get("/practice-sets/:setId", async (request) => {
    const auth = requireAuth(request);
    const { setId } = parse(z.object({ setId: zUuid }), request.params);
    const s = await myPracticeSet(auth, setId);
    return withContext(db, onBehalf(s.tenant_id, auth), async (tx) => {
      const refs = s.question_set as QuestionRef[];
      const items = await loadPool(tx, s.content_version_id, refs.map((r) => r.itemId));
      const grades = s.grades as Record<string, { outcome: string; fraction: number | null }>;
      return {
        id: s.id,
        status: s.status,
        score: s.score,
        questions: refs.map((ref) => {
          const p = items.get(ref.itemId)!;
          const view = participantView(p.snapshot.item, ref, p.snapshot.translations[s.locale] ?? null);
          // After submitting, practice shows the explanation (an approved use of content).
          return s.status === "submitted" ? { ...view, grade: grades[ref.itemId] ?? null, explanation: p.snapshot.translations[s.locale]?.explanation ?? p.snapshot.item.explanation } : view;
        }),
      };
    });
  });

  /** Upload a pronunciation recording for a practice question; it is analysed asynchronously. */
  app.put("/practice-sets/:setId/recordings/:itemId", async (request) => {
    const auth = requireAuth(request);
    const { setId, itemId } = parse(z.object({ setId: zUuid, itemId: zUuid }), request.params);
    const s = await myPracticeSet(auth, setId);
    if (s.status !== "open") throw new AppError("CONFLICT", { reason: "practice_submitted" });
    const audio = requireAudio(request);
    if (!(s.question_set as QuestionRef[]).some((q) => q.itemId === itemId)) throw new AppError("NOT_FOUND", { field: "itemId" });
    return withContext(db, onBehalf(s.tenant_id, auth), async (tx) => {
      const item = (await loadPool(tx, s.content_version_id, [itemId])).get(itemId)!.snapshot.item;
      if (item.contentType !== "pronunciation") throw new AppError("VALIDATION_FAILED", [{ path: "itemId", message: "not a pronunciation question" }]);
      const recordingId = newId();
      const key = `recordings/${s.tenant_id}/practice/${setId}/${recordingId}`;
      await ai.blobs.put(key, audio.data, audio.type);
      await tx.insertInto("recordings").values({ id: recordingId, tenant_id: s.tenant_id, attempt_id: null, practice_set_id: setId, item_id: itemId, student_id: s.student_id, storage_key: key, mime_type: audio.type, bytes: audio.data.length, retain_until: null, deleted_at: null, deleted_reason: null }).execute();
      const answers = { ...(s.answers as Record<string, unknown>), [itemId]: { recordingId } };
      await tx.updateTable("practice_sets").set({ answers: JSON.stringify(answers) }).where("id", "=", setId).execute();
      await enqueueAiJob(tx, { tenantId: s.tenant_id, competitionId: null, kind: "pronunciation", dedupeKey: `pronunciation:${recordingId}`, payload: { recordingId } });
      return { recordingId, status: "analysis_pending" };
    });
  });

  /** Grade a practice set. Pronunciation answers use the AI assessment when it has arrived. */
  app.post("/practice-sets/:setId/submit", async (request) => {
    const auth = requireAuth(request);
    const { setId } = parse(z.object({ setId: zUuid }), request.params);
    const body = parse(z.object({ answers: z.array(z.object({ itemId: zUuid, response: z.record(z.string(), z.unknown()).nullable() })).max(100) }), request.body);
    const s = await myPracticeSet(auth, setId);
    if (s.status !== "open") throw new AppError("CONFLICT", { reason: "practice_submitted" });
    return withContext(db, onBehalf(s.tenant_id, auth), async (tx) => {
      const refs = s.question_set as QuestionRef[];
      const items = await loadPool(tx, s.content_version_id, refs.map((r) => r.itemId));
      const answers: Record<string, unknown> = { ...(s.answers as Record<string, unknown>) };
      for (const a of body.answers) if (refs.some((r) => r.itemId === a.itemId)) answers[a.itemId] = a.response;
      const aiGrades = s.grades as Record<string, { outcome: string; fraction: number | null }>;
      const grades: Record<string, unknown> = {};
      const graded = [];
      const perSkill = new Map<string, { correct: number; total: number }>();
      let pending = 0;
      for (const ref of refs) {
        const item = items.get(ref.itemId)!.snapshot.item;
        const response = (answers[ref.itemId] ?? null) as ItemResponse | null;
        let g = response === null ? { outcome: "unanswered" as const, fraction: 0 } : gradeResponse(item, response);
        if (g.outcome === "pending_ai" && aiGrades[ref.itemId]?.fraction != null) g = aiGrades[ref.itemId] as typeof g;
        if (g.fraction === null) pending++;
        grades[ref.itemId] = g;
        const gi = toGradedItem({ itemId: ref.itemId, points: item.points, difficulty: item.difficulty }, g);
        if (gi) {
          graded.push(gi);
          for (const sk of item.skillIds) {
            const v = perSkill.get(sk) ?? { correct: 0, total: 0 };
            v.correct += g.fraction ?? 0;
            v.total += 1;
            perSkill.set(sk, v);
          }
        }
      }
      const { items: _i, ...score } = scoreAttempt(graded, { ...DEFAULT_SCORING_RULE, partialCredit: "proportional" });
      void _i;
      const now = new Date();
      await tx.updateTable("practice_sets").set({ status: "submitted", submitted_at: now, answers: JSON.stringify(answers), grades: JSON.stringify(grades), score: JSON.stringify({ ...score, pending }) }).where("id", "=", setId).execute();
      for (const [skillId, v] of perSkill) {
        await sql`
          insert into skill_observations (tenant_id, student_id, skill_id, practice_set_id, source, correct, total, observed_at)
          values (${s.tenant_id}, ${s.student_id}, ${skillId}, ${setId}, 'practice', ${v.correct}, ${v.total}, ${now})
          on conflict (coalesce(attempt_id, practice_set_id), skill_id) do update set correct = excluded.correct, total = excluded.total`.execute(tx);
      }
      return { id: setId, status: "submitted", score: { ...score, pending } };
    });
  });

  // ================================================================ feedback

  async function feedbackFor(request: FastifyRequest, target: { attemptId?: string; practiceSetId?: string }) {
    const auth = requireAuth(request);
    const locale = (isLocale(request.locale) ? request.locale : "en") as Locale;
    let tenantId: string;
    let competitionId: string | null = null;
    if (target.attemptId) {
      const a = await withContext(db, personal(auth), (tx) => tx.selectFrom("attempts").selectAll().where("id", "=", target.attemptId!).executeTakeFirst());
      if (!a) throw new AppError("NOT_FOUND");
      if (a.status !== "submitted") throw new AppError("CONFLICT", { reason: "attempt_not_submitted" });
      const allowed = await withContext(db, systemTenantContext(a.tenant_id), async (tx) => {
        const comp = await tx.selectFrom("competitions as c").innerJoin("competition_versions as v", "v.id", "c.current_version_id").select(["c.ai_feedback_enabled", "c.results_publication", "v.config"]).where("c.id", "=", a.competition_id).executeTakeFirstOrThrow();
        if (!comp.ai_feedback_enabled) return false;
        if (a.kind === "practice") return true;
        const config = CompetitionConfigSchema.parse(comp.config);
        if (config.rounds.find((r) => r.id === a.round_id)?.groups.find((g) => g.groupId === a.group_id)?.ui.showScoreOnSubmit) return true;
        // Official attempts: only once its result is published and visible.
        const published = await tx.selectFrom("result_entries as e").innerJoin("result_versions as v", "v.id", "e.result_version_id").select("v.id").where("e.attempt_id", "=", a.id).where("v.status", "=", "published").executeTakeFirst();
        return !!published && resultsVisibleNow(comp.results_publication, config);
      });
      if (!allowed) throw new AppError("CONFLICT", { reason: "feedback_not_available_yet" });
      tenantId = a.tenant_id;
      competitionId = a.competition_id;
    } else {
      const s = await myPracticeSet(auth, target.practiceSetId!);
      if (s.status !== "submitted") throw new AppError("CONFLICT", { reason: "practice_not_submitted" });
      tenantId = s.tenant_id;
    }
    const key = target.attemptId ? `feedback:attempt:${target.attemptId}` : `feedback:practice:${target.practiceSetId}`;
    return withContext(db, systemTenantContext(tenantId), async (tx) => {
      const existing = await tx.selectFrom("ai_feedback").selectAll().where(target.attemptId ? "attempt_id" : "practice_set_id", "=", (target.attemptId ?? target.practiceSetId)!).executeTakeFirst();
      if (existing) return { status: "ready", source: existing.source, feedback: existing.feedback, locale: existing.locale };
      const job = await tx.selectFrom("ai_jobs").select(["status"]).where("dedupe_key", "=", key).executeTakeFirst();
      if (job?.status === "failed") {
        // The AI never blocks the student: serve the deterministic version.
        const { facts } = await feedbackFacts(tx, target, locale);
        return { status: "ready", source: "fallback", feedback: fallbackFeedback(facts), locale };
      }
      await enqueueAiJob(tx, { tenantId, competitionId, kind: "feedback", dedupeKey: key, payload: { ...target, locale } });
      return { status: "pending" };
    });
  }

  app.get("/attempts/:attemptId/feedback", async (request, reply) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const out = await feedbackFor(request, { attemptId });
    return reply.status(out.status === "pending" ? 202 : 200).send(out);
  });

  app.get("/practice-sets/:setId/feedback", async (request, reply) => {
    const { setId } = parse(z.object({ setId: zUuid }), request.params);
    const out = await feedbackFor(request, { practiceSetId: setId });
    return reply.status(out.status === "pending" ? 202 : 200).send(out);
  });
}

export function requireAudio(request: FastifyRequest): { data: Buffer; type: string } {
  const type = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!AUDIO_TYPES.includes(type) || !Buffer.isBuffer(request.body)) throw new AppError("VALIDATION_FAILED", [{ path: "body", message: `send audio as one of ${AUDIO_TYPES.join(", ")}` }]);
  if (request.body.length === 0) throw new AppError("VALIDATION_FAILED", [{ path: "body", message: "empty recording" }]);
  return { data: request.body, type };
}
