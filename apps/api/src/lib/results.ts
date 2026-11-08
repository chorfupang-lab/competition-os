import type { FastifyRequest } from "fastify";
import {
  AppError,
  CompetitionConfigSchema,
  QualificationError,
  ResultsError,
  computeResults,
  diffResults,
  type AttemptRecord,
  type ParticipantInput,
  type ResultEntry,
  type ResultOverride,
} from "@cos/core";
import type { ResultEntryRow, ResultVersion, Tx } from "@cos/db";
import { audit } from "./audit.ts";
import { newId } from "./crypto.ts";

/**
 * Official results for one round × group.
 *
 *   compute → draft version (immutable snapshot of every entry)
 *   submit  → in_review; judges record approve / changes_requested
 *   approve → Head Judge only; publishes it and supersedes the previous one
 *
 * Any later change (an emergency fix, a grade, a Head Judge override)
 * produces a NEW version; earlier versions are kept with their entries.
 */

export function entryFromRow(r: ResultEntryRow): ResultEntry {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    registrationId: r.registration_id,
    studentId: r.student_id,
    attemptId: r.attempt_id,
    status: r.status,
    totalScore: num(r.total_score),
    originalScore: num(r.original_score),
    accuracy: num(r.accuracy),
    timeMs: num(r.time_ms),
    hardQuestionScore: num(r.hard_question_score),
    submittedAt: r.submitted_at?.toISOString() ?? null,
    rank: r.rank,
    tiedWith: r.tied_with,
    scopeRanks: r.scope_ranks as ResultEntry["scopeRanks"],
    qualified: r.qualified,
    qualificationBasis: r.qualification_basis,
    overrides: r.overrides as ResultOverride[],
  };
}

export async function publishedVersion(tx: Tx, roundId: string, groupId: string) {
  return tx.selectFrom("result_versions").selectAll().where("round_id", "=", roundId).where("group_id", "=", groupId).where("status", "=", "published").executeTakeFirst();
}

async function versionEntries(tx: Tx, versionId: string): Promise<ResultEntry[]> {
  return (await tx.selectFrom("result_entries").selectAll().where("result_version_id", "=", versionId).execute()).map((r) => entryFromRow(r as ResultEntryRow));
}

/** Attempts in this round × group still waiting for AI or manual grading, and unresolved integrity cases. */
export async function blockers(tx: Tx, competitionId: string, roundId: string, groupId: string) {
  const pending = await tx
    .selectFrom("attempts")
    .select(["id", "score_status"])
    .where("competition_id", "=", competitionId)
    .where("round_id", "=", roundId)
    .where("group_id", "=", groupId)
    .where("kind", "=", "official")
    .where((eb) => eb.or([eb("score_status", "in", ["pending_ai", "pending_manual"]), eb("status", "in", ["in_progress", "paused"])]))
    .execute();
  const openCases = await tx
    .selectFrom("risk_cases as rc")
    .innerJoin("attempts as a", "a.id", "rc.attempt_id")
    .select(["rc.id", "rc.status", "a.id as attempt_id"])
    .where("a.competition_id", "=", competitionId)
    .where("a.round_id", "=", roundId)
    .where("a.group_id", "=", groupId)
    .where("rc.status", "in", ["flagged", "under_review"])
    .execute();
  return { pending: pending.map((p) => ({ attemptId: p.id, scoreStatus: p.score_status })), openCases: openCases.map((c) => ({ riskCaseId: c.id, attemptId: c.attempt_id, status: c.status })) };
}

export interface ComputeOptions {
  competitionId: string;
  roundId: string;
  groupId: string;
  /** Replace the override list; omitted = carry the latest version's overrides. */
  overrides?: ResultOverride[] | undefined;
  trigger: "manual" | "recalculation";
  note?: string | null | undefined;
  actorUserId: string | null;
}

export async function computeDraft(tx: Tx, request: FastifyRequest | null, tenantId: string, o: ComputeOptions): Promise<ResultVersion> {
  const comp = await tx.selectFrom("competitions").select(["current_version_id", "tenant_id"]).where("id", "=", o.competitionId).where("tenant_id", "=", tenantId).executeTakeFirst();
  if (!comp?.current_version_id) throw new AppError("NOT_FOUND");
  const v = await tx.selectFrom("competition_versions").select("config").where("id", "=", comp.current_version_id).executeTakeFirstOrThrow();
  const config = CompetitionConfigSchema.parse(v.config);
  const round = config.rounds.find((r) => r.id === o.roundId);
  const rg = round?.groups.find((g) => g.groupId === o.groupId && g.enabled);
  if (!round || !rg) throw new AppError("NOT_FOUND", { field: "roundId" });
  if (round.kind === "practice") throw new AppError("CONFLICT", { reason: "practice_rounds_have_no_official_results" });
  const cancelled = await tx.selectFrom("round_states").select("status").where("competition_id", "=", o.competitionId).where("round_id", "=", o.roundId).executeTakeFirst();
  if (cancelled) throw new AppError("CONFLICT", { reason: "round_cancelled" });

  // Participants: confirmed registrations in this group; for a qualified-entry round, only those qualified from the source round.
  let regQuery = tx
    .selectFrom("registrations as r")
    .leftJoin("school_students as ss", (j) => j.onRef("ss.student_id", "=", "r.student_id").onRef("ss.school_id", "=", "r.school_id"))
    .select(["r.id", "r.student_id", "r.school_id", "ss.class_name"])
    .where("r.competition_id", "=", o.competitionId)
    .where("r.group_id", "=", o.groupId)
    .where("r.status", "=", "confirmed");
  if (round.entry.type === "qualified_from") {
    const source = await publishedVersion(tx, round.entry.roundId, o.groupId);
    if (!source) throw new AppError("CONFLICT", { reason: "source_round_not_published" });
    regQuery = regQuery.where((eb) =>
      eb(eb.ref("r.id"), "in", eb.selectFrom("result_entries").select("registration_id").where("result_version_id", "=", source.id).where("qualified", "=", true)),
    );
  }
  const regs = await regQuery.execute();
  const attempts = regs.length
    ? await tx
        .selectFrom("attempts")
        .select(["id", "registration_id", "status", "score", "submitted_at"])
        .where("round_id", "=", o.roundId)
        .where("kind", "=", "official")
        .where("registration_id", "in", regs.map((r) => r.id))
        .where("status", "in", ["submitted", "invalidated"])
        .execute()
    : [];
  const disqualified = new Set(
    (await tx
      .selectFrom("risk_cases as rc")
      .innerJoin("attempts as a", "a.id", "rc.attempt_id")
      .select("a.registration_id")
      .where("a.round_id", "=", o.roundId)
      .where("rc.status", "=", "disqualified")
      .execute()).map((x) => x.registration_id),
  );

  const participants: ParticipantInput[] = regs.map((r) => ({
    registrationId: r.id,
    studentId: r.student_id,
    disqualified: disqualified.has(r.id),
    scopes: { ...(r.school_id && { school: r.school_id }), ...(r.class_name && r.school_id && { class: `${r.school_id}:${r.class_name}` }) },
    attempts: attempts
      .filter((a) => a.registration_id === r.id)
      .map((a): AttemptRecord => {
        const s = (a.score ?? {}) as { totalScore?: number; accuracy?: number; timeMs?: number; hardQuestionScore?: number };
        return {
          attemptId: a.id,
          status: a.status === "invalidated" ? "invalidated" : "submitted",
          totalScore: s.totalScore ?? 0,
          accuracy: s.accuracy ?? 0,
          timeMs: s.timeMs ?? 0,
          hardQuestionScore: s.hardQuestionScore ?? 0,
          submittedAt: (a.submitted_at ?? new Date(0)).toISOString(),
        };
      }),
  }));

  const latest = await tx
    .selectFrom("result_versions")
    .select(["id", "status", "version_number", "inputs"])
    .where("round_id", "=", o.roundId)
    .where("group_id", "=", o.groupId)
    .orderBy("version_number", "desc")
    .executeTakeFirst();
  const carried = ((latest?.inputs as { overrides?: ResultOverride[] } | undefined)?.overrides ?? []).filter((x) => regs.some((r) => r.id === x.registrationId));
  const overrides = o.overrides ?? carried;

  let entries: ResultEntry[];
  try {
    entries = computeResults({ participants, policy: round.attemptPolicy, tieBreakers: rg.ranking.tieBreakers, scopes: rg.ranking.scopes, qualification: rg.qualification, overrides });
  } catch (err) {
    if (err instanceof ResultsError || err instanceof QualificationError) throw new AppError("VALIDATION_FAILED", [{ path: "overrides", message: (err as Error).message }]);
    throw err;
  }

  // One open version at a time: a fresh computation replaces an unpublished one.
  const open = await tx.selectFrom("result_versions").select(["id", "status"]).where("round_id", "=", o.roundId).where("group_id", "=", o.groupId).where("status", "in", ["draft", "in_review", "approved"]).execute();
  for (const x of open) await tx.updateTable("result_versions").set({ status: "discarded" }).where("id", "=", x.id).execute();

  const published = await publishedVersion(tx, o.roundId, o.groupId);
  const changes = published ? diffResults(await versionEntries(tx, published.id), entries) : [];
  const adjustments = await tx.selectFrom("question_adjustments").select(["id", "item_id", "kind"]).where("round_id", "=", o.roundId).execute();
  const b = await blockers(tx, o.competitionId, o.roundId, o.groupId);
  const id = newId();
  await tx
    .insertInto("result_versions")
    .values({
      id,
      tenant_id: tenantId,
      competition_id: o.competitionId,
      round_id: o.roundId,
      group_id: o.groupId,
      version_number: (latest?.version_number ?? 0) + 1,
      status: "draft",
      competition_version_id: comp.current_version_id,
      inputs: JSON.stringify({ overrides, adjustments, attemptIds: attempts.map((a) => a.id).sort() }),
      changes: JSON.stringify(changes),
      summary: JSON.stringify({
        participants: entries.length,
        ranked: entries.filter((e) => e.rank !== null).length,
        qualified: entries.filter((e) => e.qualified).length,
        disqualified: entries.filter((e) => e.status === "disqualified").length,
        noAttempt: entries.filter((e) => e.status === "no_attempt").length,
        pending: b.pending,
        openRiskCases: b.openCases,
        supersedes: published?.id ?? null,
      }),
      trigger: o.trigger,
      note: o.note ?? null,
      created_by: o.actorUserId,
    })
    .execute();
  for (let i = 0; i < entries.length; i += 500) {
    await tx
      .insertInto("result_entries")
      .values(
        entries.slice(i, i + 500).map((e) => ({
          tenant_id: tenantId,
          result_version_id: id,
          registration_id: e.registrationId,
          student_id: e.studentId,
          attempt_id: e.attemptId,
          status: e.status,
          total_score: e.totalScore,
          original_score: e.originalScore,
          accuracy: e.accuracy,
          time_ms: e.timeMs,
          hard_question_score: e.hardQuestionScore,
          submitted_at: e.submittedAt,
          rank: e.rank,
          tied_with: e.tiedWith,
          scope_ranks: JSON.stringify(e.scopeRanks),
          qualified: e.qualified,
          qualification_basis: e.qualificationBasis,
          overrides: JSON.stringify(e.overrides),
        })),
      )
      .execute();
  }
  await audit(tx, request, {
    tenantId,
    actorUserId: o.actorUserId,
    action: o.trigger === "recalculation" ? "results.recalculated" : "results.computed",
    targetType: "result_version",
    targetId: id,
    reason: o.note ?? null,
    after: { roundId: o.roundId, groupId: o.groupId, versionNumber: (latest?.version_number ?? 0) + 1, changes: changes.length, overrides: overrides.length },
    ...(o.actorUserId === null && { metadata: { via: "system" } }),
  });
  return (await tx.selectFrom("result_versions").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as ResultVersion;
}

/**
 * After an emergency action changes scores, recompute every round × group
 * that already has results, so before/after is visible and a new version
 * goes through review and approval again.
 */
export async function recalculateAffected(tx: Tx, request: FastifyRequest | null, tenantId: string, competitionId: string, roundId: string, groupIds: string[] | null, actorUserId: string, note: string) {
  let q = tx.selectFrom("result_versions").select(["group_id"]).distinct().where("competition_id", "=", competitionId).where("round_id", "=", roundId).where("status", "in", ["draft", "in_review", "approved", "published"]);
  if (groupIds) q = q.where("group_id", "in", groupIds);
  const groups = (await q.execute()).map((g) => g.group_id);
  const versions: string[] = [];
  for (const groupId of groups) {
    const v = await computeDraft(tx, request, tenantId, { competitionId, roundId, groupId, trigger: "recalculation", note, actorUserId });
    versions.push(v.id);
  }
  return versions;
}
