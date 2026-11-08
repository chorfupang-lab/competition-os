import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, anonymousCode, displayName, type Permission, type ResultOverride } from "@cos/core";
import { withContext, type Attempt, type Tx } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { blockers, computeDraft, entryFromRow, recalculateAffected } from "../lib/results.ts";
import { rescoreAttempt } from "../lib/runtime.ts";
import { permissionsInCompetition, resolveTenantScope, type TenantScope } from "../lib/tenant-scope.ts";
import { parse, zReason, zUuid } from "../lib/validation.ts";

const OverrideSchema = z.discriminatedUnion("type", [
  z.object({ registrationId: zUuid, type: z.literal("score"), totalScore: z.number().min(-100_000).max(100_000), reason: zReason }),
  z.object({ registrationId: zUuid, type: z.literal("qualification"), action: z.enum(["include", "exclude"]), reason: zReason }),
]);

/** Integrity review, manual grading and the official result workflow. */
export async function judgingRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const scopeOf = (request: FastifyRequest) => resolveTenantScope(db, request, parse(z.object({ tenantId: zUuid }).passthrough(), request.params).tenantId);
  const perms = (scope: TenantScope, competitionId: string) => permissionsInCompetition(scope, competitionId);
  const need = (scope: TenantScope, competitionId: string, ...any: Permission[]) => {
    const p = perms(scope, competitionId);
    if (!any.some((x) => p.has(x))) throw new AppError("FORBIDDEN");
  };
  const actor = (scope: TenantScope) => ({ tenantId: scope.tenant.id, actorUserId: scope.auth.userId });
  const cid = (request: FastifyRequest) => parse(z.object({ competitionId: zUuid }).passthrough(), request.params).competitionId;

  // ================================================================ integrity review

  app.get("/competitions/:competitionId/risk-cases", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    need(scope, competitionId, "review.submit");
    const { status } = parse(z.object({ status: z.enum(["flagged", "under_review", "cleared", "warning", "disqualified"]).optional() }), request.query);
    const rows = await withContext(db, scope.db, (tx) => {
      let q = tx
        .selectFrom("risk_cases as rc")
        .innerJoin("attempts as a", "a.id", "rc.attempt_id")
        .select(["rc.id", "rc.status", "rc.risk_score", "rc.signals", "rc.created_at", "rc.decided_at", "rc.decision_reason", "a.id as attempt_id", "a.round_id", "a.group_id", "a.student_id", "a.registration_id"])
        .where("a.competition_id", "=", competitionId)
        .orderBy("rc.risk_score", "desc");
      if (status) q = q.where("rc.status", "=", status);
      return q.execute();
    });
    return {
      riskCases: rows.map((r) => ({ id: r.id, status: r.status, riskScore: r.risk_score, signals: r.signals, createdAt: r.created_at, decidedAt: r.decided_at, decisionReason: r.decision_reason, attemptId: r.attempt_id, roundId: r.round_id, groupId: r.group_id, studentId: r.student_id, registrationId: r.registration_id })),
    };
  });

  async function loadAttempt(tx: Tx, scope: TenantScope, attemptId: string) {
    const a = await tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).where("tenant_id", "=", scope.tenant.id).forUpdate().executeTakeFirst();
    if (!a) throw new AppError("NOT_FOUND");
    return a as Attempt;
  }

  async function loadCase(tx: Tx, scope: TenantScope, caseId: string) {
    const c = await tx
      .selectFrom("risk_cases as rc")
      .innerJoin("attempts as a", "a.id", "rc.attempt_id")
      .selectAll("rc")
      .select(["a.competition_id", "a.round_id", "a.group_id"])
      .where("rc.id", "=", caseId)
      .where("rc.tenant_id", "=", scope.tenant.id)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw new AppError("NOT_FOUND");
    return c;
  }

  /** Judges can open a case on any attempt they find suspicious or ambiguous. */
  app.post("/attempts/:attemptId/risk-case", async (request, reply) => {
    const scope = await scopeOf(request);
    const { attemptId } = parse(z.object({ attemptId: zUuid }).passthrough(), request.params);
    const { note } = parse(z.object({ note: zReason }), request.body);
    const c = await withContext(db, scope.db, async (tx) => {
      const a = await loadAttempt(tx, scope, attemptId);
      need(scope, a.competition_id, "review.submit");
      const existing = await tx.selectFrom("risk_cases").select("id").where("attempt_id", "=", attemptId).executeTakeFirst();
      if (existing) throw new AppError("CONFLICT", { reason: "case_exists", riskCaseId: existing.id });
      const c = await tx.insertInto("risk_cases").values({ tenant_id: scope.tenant.id, attempt_id: attemptId, status: "under_review", risk_score: a.risk_score, signals: JSON.stringify([]), opened_by: scope.auth.userId }).returningAll().executeTakeFirstOrThrow();
      await tx.insertInto("risk_case_reviews").values({ tenant_id: scope.tenant.id, risk_case_id: c.id, reviewer_user_id: scope.auth.userId, kind: "note", recommendation: null, decision: null, note }).execute();
      await audit(tx, request, { ...actor(scope), action: "integrity.case_opened", targetType: "risk_case", targetId: c.id, reason: note, after: { attemptId } });
      return c;
    });
    return reply.status(201).send({ riskCase: { id: c.id, status: c.status } });
  });

  app.get("/risk-cases/:caseId", async (request) => {
    const scope = await scopeOf(request);
    const { caseId } = parse(z.object({ caseId: zUuid }).passthrough(), request.params);
    return withContext(db, scope.db, async (tx) => {
      const c = await loadCase(tx, scope, caseId);
      need(scope, c.competition_id, "review.submit");
      const reviews = await tx.selectFrom("risk_case_reviews").selectAll().where("risk_case_id", "=", caseId).orderBy("created_at").execute();
      return {
        riskCase: { id: c.id, status: c.status, riskScore: c.risk_score, signals: c.signals, attemptId: c.attempt_id, decidedBy: c.decided_by, decidedAt: c.decided_at, decisionReason: c.decision_reason },
        reviews: reviews.map((r) => ({ id: r.id, reviewerUserId: r.reviewer_user_id, kind: r.kind, recommendation: r.recommendation, decision: r.decision, note: r.note, createdAt: r.created_at })),
      };
    });
  });

  /** A judge's recommendation or note. Moves a flagged case to under_review. */
  app.post("/risk-cases/:caseId/reviews", async (request, reply) => {
    const scope = await scopeOf(request);
    const { caseId } = parse(z.object({ caseId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ recommendation: z.enum(["clear", "warning", "disqualify"]).optional(), note: zReason }), request.body);
    await withContext(db, scope.db, async (tx) => {
      const c = await loadCase(tx, scope, caseId);
      need(scope, c.competition_id, "review.submit");
      if (!["flagged", "under_review"].includes(c.status)) throw new AppError("CONFLICT", { reason: "case_closed", status: c.status });
      await tx.insertInto("risk_case_reviews").values({ tenant_id: scope.tenant.id, risk_case_id: caseId, reviewer_user_id: scope.auth.userId, kind: body.recommendation ? "recommendation" : "note", recommendation: body.recommendation ?? null, decision: null, note: body.note }).execute();
      if (c.status === "flagged") await tx.updateTable("risk_cases").set({ status: "under_review" }).where("id", "=", caseId).execute();
      await audit(tx, request, { ...actor(scope), action: "integrity.reviewed", targetType: "risk_case", targetId: caseId, after: { recommendation: body.recommendation ?? null } });
    });
    return reply.status(201).send({ ok: true });
  });

  /**
   * Close a case. Judges may clear or warn; only a Head Judge may disqualify.
   * A disqualification re-computes results that already exist for the round.
   */
  app.post("/risk-cases/:caseId/decision", async (request) => {
    const scope = await scopeOf(request);
    const { caseId } = parse(z.object({ caseId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ decision: z.enum(["cleared", "warning", "disqualified"]), reason: zReason }), request.body);
    const result = await withContext(db, scope.db, async (tx) => {
      const c = await loadCase(tx, scope, caseId);
      need(scope, c.competition_id, body.decision === "disqualified" ? "integrity.disqualify" : "review.submit");
      if (!["flagged", "under_review"].includes(c.status)) throw new AppError("CONFLICT", { reason: "case_closed", status: c.status });
      await tx.updateTable("risk_cases").set({ status: body.decision, decided_by: scope.auth.userId, decided_at: new Date(), decision_reason: body.reason }).where("id", "=", caseId).execute();
      await tx.insertInto("risk_case_reviews").values({ tenant_id: scope.tenant.id, risk_case_id: caseId, reviewer_user_id: scope.auth.userId, kind: "decision", recommendation: null, decision: body.decision, note: body.reason }).execute();
      await audit(tx, request, { ...actor(scope), action: "integrity.decided", targetType: "risk_case", targetId: caseId, reason: body.reason, before: { status: c.status }, after: { status: body.decision } });
      const recalculated = body.decision === "disqualified"
        ? await recalculateAffected(tx, request, scope.tenant.id, c.competition_id, c.round_id, [c.group_id], scope.auth.userId, `Disqualification: ${body.reason}`)
        : [];
      return { recalculated };
    });
    return { ok: true, status: body.decision, recalculatedVersions: result.recalculated };
  });

  // ================================================================ manual grading

  /**
   * Judges grade questions waiting for a person (custom items) or for AI
   * (pronunciation fallback). Re-grading an already graded question is an
   * official result override and needs a Head Judge.
   */
  app.post("/attempts/:attemptId/grades", async (request) => {
    const scope = await scopeOf(request);
    const { attemptId } = parse(z.object({ attemptId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ itemId: zUuid, fraction: z.number().min(0).max(1), note: zReason }), request.body);
    return withContext(db, scope.db, async (tx) => {
      const a = await loadAttempt(tx, scope, attemptId);
      need(scope, a.competition_id, "review.submit");
      if (a.status !== "submitted") throw new AppError("CONFLICT", { reason: "attempt_not_submitted" });
      const answer = await tx.selectFrom("attempt_answers").selectAll().where("attempt_id", "=", attemptId).where("item_id", "=", body.itemId).executeTakeFirst();
      if (!answer) throw new AppError("NOT_FOUND", { field: "itemId", hint: "unanswered questions score zero" });
      const prior = answer.grade as { outcome?: string; fraction?: number | null } | null;
      const pending = prior?.outcome === "pending_ai" || prior?.outcome === "pending_manual";
      if (!pending && !perms(scope, a.competition_id).has("result.override")) throw new AppError("FORBIDDEN", { reason: "regrading_needs_head_judge" });
      const f = Math.round(body.fraction * 1e6) / 1e6;
      const grade = { outcome: f >= 1 ? "correct" : f <= 0 ? "incorrect" : "partial", fraction: f, manual: true, gradedBy: scope.auth.userId, note: body.note };
      await tx.updateTable("attempt_answers").set({ grade: JSON.stringify(grade) }).where("attempt_id", "=", attemptId).where("item_id", "=", body.itemId).execute();
      const rescored = await rescoreAttempt(tx, a, `Manual grade: ${body.note}`, null);
      await audit(tx, request, { ...actor(scope), action: pending ? "grading.manual" : "grading.override", targetType: "attempt", targetId: attemptId, reason: body.note, before: { itemId: body.itemId, grade: prior, score: rescored.before }, after: { grade, score: rescored.after } });
      const recalculated = await recalculateAffected(tx, request, scope.tenant.id, a.competition_id, a.round_id, [a.group_id], scope.auth.userId, `Grade changed on attempt ${attemptId}`);
      return { score: rescored.after, scoreStatus: rescored.scoreStatus, recalculatedVersions: recalculated };
    });
  });

  // ================================================================ results

  app.patch("/competitions/:competitionId/results-settings", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    need(scope, competitionId, "competitions.manage");
    const body = parse(
      z.object({
        resultsPublication: z.enum(["on_approval", "after_competition_ends", "never"]).optional(),
        leaderboardPrivacy: z.enum(["full_name", "first_name_initial", "nickname", "anonymous_code", "rank_score_only"]).optional(),
        liveLeaderboard: z.boolean().optional(),
      }),
      request.body,
    );
    await withContext(db, scope.db, async (tx) => {
      const changes = {
        ...(body.resultsPublication && { results_publication: body.resultsPublication }),
        ...(body.leaderboardPrivacy && { leaderboard_privacy: body.leaderboardPrivacy }),
        ...(body.liveLeaderboard !== undefined && { live_leaderboard: body.liveLeaderboard }),
      };
      if (!Object.keys(changes).length) return;
      const r = await tx.updateTable("competitions").set(changes).where("id", "=", competitionId).where("tenant_id", "=", scope.tenant.id).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new AppError("NOT_FOUND");
      await audit(tx, request, { ...actor(scope), action: "competition.results_settings_updated", targetType: "competition", targetId: competitionId, after: body });
    });
    return { ok: true };
  });

  /** Compute a draft result version. Supplying overrides is an official result override (Head Judge only). */
  app.post("/competitions/:competitionId/results", async (request, reply) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    need(scope, competitionId, "competitions.manage", "review.approve");
    const body = parse(z.object({ roundId: zUuid, groupId: zUuid, overrides: z.array(OverrideSchema).max(1000).optional(), note: z.string().trim().max(2000).optional() }), request.body);
    if (body.overrides !== undefined) need(scope, competitionId, "result.override");
    const version = await withContext(db, scope.db, (tx) =>
      computeDraft(tx, request, scope.tenant.id, { competitionId, roundId: body.roundId, groupId: body.groupId, overrides: body.overrides as ResultOverride[] | undefined, trigger: "manual", note: body.note, actorUserId: scope.auth.userId }),
    );
    return reply.status(201).send({ version: presentVersion(version) });
  });

  app.get("/competitions/:competitionId/results", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    need(scope, competitionId, "competitions.manage", "review.submit", "ranking.read");
    const q = parse(z.object({ roundId: zUuid.optional(), groupId: zUuid.optional() }), request.query);
    const rows = await withContext(db, scope.db, (tx) => {
      let query = tx.selectFrom("result_versions").selectAll().where("competition_id", "=", competitionId).orderBy("round_id").orderBy("group_id").orderBy("version_number", "desc");
      if (q.roundId) query = query.where("round_id", "=", q.roundId);
      if (q.groupId) query = query.where("group_id", "=", q.groupId);
      return query.execute();
    });
    return { versions: rows.map(presentVersion) };
  });

  async function loadVersion(tx: Tx, scope: TenantScope, versionId: string) {
    const v = await tx.selectFrom("result_versions").selectAll().where("id", "=", versionId).where("tenant_id", "=", scope.tenant.id).forUpdate().executeTakeFirst();
    if (!v) throw new AppError("NOT_FOUND");
    return v;
  }

  app.get("/results/:versionId", async (request) => {
    const scope = await scopeOf(request);
    const { versionId } = parse(z.object({ versionId: zUuid }).passthrough(), request.params);
    return withContext(db, scope.db, async (tx) => {
      const v = await loadVersion(tx, scope, versionId);
      need(scope, v.competition_id, "competitions.manage", "review.submit", "ranking.read");
      const rows = await tx
        .selectFrom("result_entries as e")
        // Left join: judges without tenant-wide student access review blind (anonymous codes).
        .leftJoin("students as s", "s.id", "e.student_id")
        .selectAll("e")
        .select(["s.student_code", "s.given_name", "s.family_name", "s.preferred_name", "s.nickname"])
        .where("e.result_version_id", "=", versionId)
        .orderBy("e.rank")
        .orderBy("e.registration_id")
        .execute();
      const reviews = await tx.selectFrom("result_reviews").selectAll().where("result_version_id", "=", versionId).orderBy("created_at").execute();
      return {
        version: presentVersion(v),
        entries: rows.map((r) => ({
          ...entryFromRow(r),
          student: r.student_code
            ? { studentCode: r.student_code, name: displayName("full_name", { competitionId: v.competition_id, studentId: r.student_id, givenName: r.given_name, familyName: r.family_name, preferredName: r.preferred_name, nickname: r.nickname }) }
            : { studentCode: null, name: anonymousCode(v.competition_id, r.student_id) },
        })),
        reviews: reviews.map((r) => ({ id: r.id, reviewerUserId: r.reviewer_user_id, recommendation: r.recommendation, note: r.note, createdAt: r.created_at })),
      };
    });
  });

  app.post("/results/:versionId/submit", async (request) => {
    const scope = await scopeOf(request);
    const { versionId } = parse(z.object({ versionId: zUuid }).passthrough(), request.params);
    const v = await withContext(db, scope.db, async (tx) => {
      const v = await loadVersion(tx, scope, versionId);
      need(scope, v.competition_id, "competitions.manage", "review.approve");
      if (v.status !== "draft") throw new AppError("CONFLICT", { reason: "not_draft", status: v.status });
      const u = await tx.updateTable("result_versions").set({ status: "in_review", submitted_at: new Date() }).where("id", "=", versionId).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "results.submitted_for_review", targetType: "result_version", targetId: versionId });
      return u;
    });
    return { version: presentVersion(v) };
  });

  app.post("/results/:versionId/reviews", async (request, reply) => {
    const scope = await scopeOf(request);
    const { versionId } = parse(z.object({ versionId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ recommendation: z.enum(["approve", "changes_requested"]), note: z.string().trim().max(2000).optional() }), request.body);
    if (body.recommendation === "changes_requested" && (body.note ?? "").length < 3) throw new AppError("REASON_REQUIRED", { field: "note" });
    await withContext(db, scope.db, async (tx) => {
      const v = await loadVersion(tx, scope, versionId);
      need(scope, v.competition_id, "review.submit");
      if (v.status !== "in_review") throw new AppError("CONFLICT", { reason: "not_in_review", status: v.status });
      await tx.insertInto("result_reviews").values({ tenant_id: scope.tenant.id, result_version_id: versionId, reviewer_user_id: scope.auth.userId, recommendation: body.recommendation, note: body.note ?? null }).execute();
      if (body.recommendation === "changes_requested") await tx.updateTable("result_versions").set({ status: "draft" }).where("id", "=", versionId).execute();
      await audit(tx, request, { ...actor(scope), action: "results.reviewed", targetType: "result_version", targetId: versionId, reason: body.note ?? null, after: { recommendation: body.recommendation } });
    });
    return reply.status(201).send({ ok: true });
  });

  /**
   * Head Judge approval publishes the version: the previous published one is
   * kept as superseded. Blocked while grades are pending, attempts are still
   * running, integrity cases are open, or no judge has approved it.
   */
  app.post("/results/:versionId/approve", async (request) => {
    const scope = await scopeOf(request);
    const { versionId } = parse(z.object({ versionId: zUuid }).passthrough(), request.params);
    const { note } = parse(z.object({ note: z.string().trim().max(2000).optional() }), request.body);
    const v = await withContext(db, scope.db, async (tx) => {
      const v = await loadVersion(tx, scope, versionId);
      need(scope, v.competition_id, "review.approve");
      if (v.status !== "in_review") throw new AppError("CONFLICT", { reason: "not_in_review", status: v.status });
      const approvals = await tx.selectFrom("result_reviews").select("id").where("result_version_id", "=", versionId).where("recommendation", "=", "approve").execute();
      if (!approvals.length) throw new AppError("CONFLICT", { reason: "needs_judge_review" });
      const cfg = await tx.selectFrom("competition_versions").select("config").where("id", "=", v.competition_version_id).executeTakeFirstOrThrow();
      const round = (cfg.config as { rounds: Array<{ id: string; closesAt: string }> }).rounds.find((r) => r.id === v.round_id);
      const grantOpen = await tx.selectFrom("attempt_grants").select("id").where("round_id", "=", v.round_id).where("available_until", ">", new Date()).executeTakeFirst();
      if (!round || Date.parse(round.closesAt) > Date.now() || grantOpen) throw new AppError("CONFLICT", { reason: "round_still_open" });
      const b = await blockers(tx, v.competition_id, v.round_id, v.group_id);
      if (b.pending.length || b.openCases.length) throw new AppError("CONFLICT", { reason: "unresolved_items", ...b });
      // The version must reflect the current attempts (nothing changed since it was computed).
      const inputs = v.inputs as { attemptIds: string[] };
      const now = await tx.selectFrom("attempts").select("id").where("competition_id", "=", v.competition_id).where("round_id", "=", v.round_id).where("group_id", "=", v.group_id).where("kind", "=", "official").where("status", "in", ["submitted", "invalidated"]).execute();
      if (JSON.stringify(now.map((x) => x.id).sort()) !== JSON.stringify([...inputs.attemptIds].sort())) throw new AppError("CONFLICT", { reason: "attempts_changed_recompute" });

      const published = await tx.selectFrom("result_versions").select("id").where("round_id", "=", v.round_id).where("group_id", "=", v.group_id).where("status", "=", "published").executeTakeFirst();
      if (published) await tx.updateTable("result_versions").set({ status: "superseded" }).where("id", "=", published.id).execute();
      const at = new Date();
      await tx.updateTable("result_versions").set({ status: "approved", approved_by: scope.auth.userId, approved_at: at }).where("id", "=", versionId).execute();
      const u = await tx.updateTable("result_versions").set({ status: "published", published_at: at }).where("id", "=", versionId).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "results.published", targetType: "result_version", targetId: versionId, reason: note ?? null, before: { publishedVersionId: published?.id ?? null }, after: { versionNumber: v.version_number, changes: (v.changes as unknown[]).length } });
      return u;
    });
    return { version: presentVersion(v) };
  });

  app.post("/results/:versionId/discard", async (request) => {
    const scope = await scopeOf(request);
    const { versionId } = parse(z.object({ versionId: zUuid }).passthrough(), request.params);
    const { reason } = parse(z.object({ reason: zReason }), request.body);
    await withContext(db, scope.db, async (tx) => {
      const v = await loadVersion(tx, scope, versionId);
      need(scope, v.competition_id, "competitions.manage", "review.approve");
      if (!["draft", "in_review"].includes(v.status)) throw new AppError("CONFLICT", { reason: "not_open", status: v.status });
      await tx.updateTable("result_versions").set({ status: "discarded" }).where("id", "=", versionId).execute();
      await audit(tx, request, { ...actor(scope), action: "results.discarded", targetType: "result_version", targetId: versionId, reason });
    });
    return { ok: true };
  });
}

export function presentVersion(v: { id: string; competition_id: string; round_id: string; group_id: string; version_number: number; status: string; trigger: string; summary: unknown; changes: unknown; inputs: unknown; note: string | null; created_at: Date; submitted_at: Date | null; approved_by: string | null; approved_at: Date | null; published_at: Date | null }) {
  return {
    id: v.id, competitionId: v.competition_id, roundId: v.round_id, groupId: v.group_id, versionNumber: v.version_number, status: v.status, trigger: v.trigger,
    summary: v.summary, changes: v.changes, overrides: (v.inputs as { overrides?: unknown[] }).overrides ?? [], note: v.note,
    createdAt: v.created_at, submittedAt: v.submitted_at, approvedBy: v.approved_by, approvedAt: v.approved_at, publishedAt: v.published_at,
  };
}
