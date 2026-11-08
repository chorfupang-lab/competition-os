import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, CompetitionConfigSchema, attemptDeadline } from "@cos/core";
import { withContext, type Attempt, type Tx } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { recalculateAffected } from "../lib/results.ts";
import { loadVersionContext, rescoreAttempt } from "../lib/runtime.ts";
import { permissionsInCompetition, resolveTenantScope, type TenantScope } from "../lib/tenant-scope.ts";
import { parse, zReason, zUuid } from "../lib/validation.ts";

/**
 * Emergency overrides for live incidents — Head Judge only. Each one records
 * actor, time, reason, old and new values and the affected records, writes
 * the audit log, re-scores affected attempts (keeping their score history)
 * and re-computes results that already exist, as new versions.
 */
export async function emergencyRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  async function context(request: FastifyRequest) {
    const { tenantId, competitionId } = parse(z.object({ tenantId: zUuid, competitionId: zUuid }), request.params);
    const scope = await resolveTenantScope(db, request, tenantId);
    if (!permissionsInCompetition(scope, competitionId).has("emergency.override")) throw new AppError("FORBIDDEN");
    return { scope, competitionId };
  }

  async function record(
    tx: Tx,
    request: FastifyRequest,
    scope: TenantScope,
    a: { competitionId: string; roundId: string | null; groupId: string | null; kind: string; reason: string; before: unknown; after: unknown; affected: unknown },
  ) {
    const row = await tx
      .insertInto("emergency_actions")
      .values({
        tenant_id: scope.tenant.id,
        competition_id: a.competitionId,
        round_id: a.roundId,
        group_id: a.groupId,
        kind: a.kind as never,
        reason: a.reason,
        actor_user_id: scope.auth.userId,
        before: JSON.stringify(a.before),
        after: JSON.stringify(a.after),
        affected: JSON.stringify(a.affected),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await audit(tx, request, { tenantId: scope.tenant.id, actorUserId: scope.auth.userId, action: `emergency.${a.kind}`, targetType: "emergency_action", targetId: row.id, reason: a.reason, before: a.before, after: { ...(a.after as object), affected: a.affected } });
    return row.id;
  }

  async function attemptIn(tx: Tx, scope: TenantScope, competitionId: string, attemptId: string) {
    const a = await tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).where("competition_id", "=", competitionId).where("tenant_id", "=", scope.tenant.id).forUpdate().executeTakeFirst();
    if (!a) throw new AppError("NOT_FOUND", { field: "attemptId" });
    return a as Attempt;
  }

  async function roundOf(tx: Tx, competitionId: string, roundId: string) {
    const c = await tx.selectFrom("competitions as c").innerJoin("competition_versions as v", "v.id", "c.current_version_id").select("v.config").where("c.id", "=", competitionId).executeTakeFirstOrThrow();
    const round = CompetitionConfigSchema.parse(c.config).rounds.find((r) => r.id === roundId);
    if (!round) throw new AppError("NOT_FOUND", { field: "roundId" });
    return round;
  }

  app.get("/", async (request) => {
    const { scope, competitionId } = await context(request);
    const rows = await withContext(db, scope.db, (tx) => tx.selectFrom("emergency_actions").selectAll().where("competition_id", "=", competitionId).orderBy("created_at", "desc").execute());
    return { actions: rows.map((r) => ({ id: r.id, kind: r.kind, roundId: r.round_id, groupId: r.group_id, reason: r.reason, actorUserId: r.actor_user_id, before: r.before, after: r.after, affected: r.affected, createdAt: r.created_at })) };
  });

  /** Extra time for running attempts (e.g. +5 min after an outage). */
  app.post("/extend-time", async (request, reply) => {
    const { scope, competitionId } = await context(request);
    const body = parse(z.object({ roundId: zUuid, groupId: zUuid.optional(), attemptIds: z.array(zUuid).max(5000).optional(), seconds: z.number().int().min(1).max(7200), reason: zReason }), request.body);
    const out = await withContext(db, scope.db, async (tx) => {
      const round = await roundOf(tx, competitionId, body.roundId);
      let q = tx.selectFrom("attempts").selectAll().where("competition_id", "=", competitionId).where("round_id", "=", body.roundId).where("status", "in", ["in_progress", "paused"]);
      if (body.groupId) q = q.where("group_id", "=", body.groupId);
      if (body.attemptIds) q = q.where("id", "in", body.attemptIds.length ? body.attemptIds : ["00000000-0000-0000-0000-000000000000"]);
      const attempts = await q.forUpdate().execute();
      const changes = [];
      for (const a of attempts) {
        const { rg } = await loadVersionContext(tx, a.competition_version_id, a.round_id, a.group_id);
        const ext = a.extension_seconds + body.seconds;
        const deadline = attemptDeadline(a.started_at, rg.durationSeconds, ext, new Date(Date.parse(round.closesAt) + ext * 1000));
        await tx.updateTable("attempts").set({ extension_seconds: ext, deadline_at: deadline }).where("id", "=", a.id).execute();
        changes.push({ attemptId: a.id, before: { deadlineAt: a.deadline_at, extensionSeconds: a.extension_seconds }, after: { deadlineAt: deadline, extensionSeconds: ext } });
      }
      const id = await record(tx, request, scope, { competitionId, roundId: body.roundId, groupId: body.groupId ?? null, kind: "extend_time", reason: body.reason, before: { seconds: 0 }, after: { seconds: body.seconds }, affected: { attempts: changes } });
      return { id, changes };
    });
    return reply.status(201).send({ actionId: out.id, affected: out.changes.length, changes: out.changes });
  });

  /** Reopen a submitted attempt for a set time (e.g. it was cut off by an outage). */
  app.post("/reopen-attempt", async (request, reply) => {
    const { scope, competitionId } = await context(request);
    const body = parse(z.object({ attemptId: zUuid, seconds: z.number().int().min(30).max(7200), reason: zReason }), request.body);
    const out = await withContext(db, scope.db, async (tx) => {
      const a = await attemptIn(tx, scope, competitionId, body.attemptId);
      if (a.status !== "submitted") throw new AppError("CONFLICT", { reason: "attempt_not_submitted", status: a.status });
      const deadline = new Date(Date.now() + body.seconds * 1000);
      await tx.insertInto("attempt_score_history").values({ tenant_id: a.tenant_id, attempt_id: a.id, score: a.score === null ? null : JSON.stringify(a.score), score_status: a.score_status, reason: `Reopened: ${body.reason}`, emergency_action_id: null }).execute();
      await tx.updateTable("attempts").set({ status: "in_progress", submitted_at: null, submit_reason: null, deadline_at: deadline }).where("id", "=", a.id).execute();
      await tx.updateTable("attempt_sessions").set({ status: "active" }).where("id", "=", (await tx.selectFrom("attempt_sessions").select("id").where("attempt_id", "=", a.id).orderBy("last_seen_at", "desc").executeTakeFirstOrThrow()).id).execute();
      const id = await record(tx, request, scope, { competitionId, roundId: a.round_id, groupId: a.group_id, kind: "reopen_attempt", reason: body.reason, before: { status: a.status, deadlineAt: a.deadline_at, submittedAt: a.submitted_at }, after: { status: "in_progress", deadlineAt: deadline }, affected: { attemptIds: [a.id] } });
      return { id };
    });
    return reply.status(201).send({ actionId: out.id });
  });

  /** Invalidate an attempt; it is kept on record but never counts. */
  app.post("/invalidate-attempt", async (request, reply) => {
    const { scope, competitionId } = await context(request);
    const body = parse(z.object({ attemptId: zUuid, reason: zReason }), request.body);
    const out = await withContext(db, scope.db, async (tx) => {
      const a = await attemptIn(tx, scope, competitionId, body.attemptId);
      if (a.status === "invalidated") throw new AppError("CONFLICT", { reason: "already_invalidated" });
      await tx.updateTable("attempts").set({ status: "invalidated", invalidated_at: new Date(), invalidated_reason: body.reason }).where("id", "=", a.id).execute();
      const id = await record(tx, request, scope, { competitionId, roundId: a.round_id, groupId: a.group_id, kind: "invalidate_attempt", reason: body.reason, before: { status: a.status }, after: { status: "invalidated" }, affected: { attemptIds: [a.id] } });
      const versions = await recalculateAffected(tx, request, scope.tenant.id, competitionId, a.round_id, [a.group_id], scope.auth.userId, `Attempt invalidated: ${body.reason}`);
      return { id, versions };
    });
    return reply.status(201).send({ actionId: out.id, recalculatedVersions: out.versions });
  });

  /** Make-up attempt: the original is kept and invalidated; one new attempt is granted (also after the round closes). */
  app.post("/makeup-attempt", async (request, reply) => {
    const { scope, competitionId } = await context(request);
    const body = parse(z.object({ attemptId: zUuid, availableHours: z.number().int().min(1).max(336).default(48), reason: zReason }), request.body);
    const out = await withContext(db, scope.db, async (tx) => {
      const a = await attemptIn(tx, scope, competitionId, body.attemptId);
      if (a.status === "in_progress" || a.status === "paused") throw new AppError("CONFLICT", { reason: "attempt_running" });
      const until = new Date(Date.now() + body.availableHours * 3_600_000);
      if (a.status !== "invalidated") await tx.updateTable("attempts").set({ status: "invalidated", invalidated_at: new Date(), invalidated_reason: `Make-up granted: ${body.reason}` }).where("id", "=", a.id).execute();
      await tx.insertInto("attempt_grants").values({ tenant_id: a.tenant_id, registration_id: a.registration_id, round_id: a.round_id, replaces_attempt_id: a.id, reason: body.reason, granted_by: scope.auth.userId, available_until: until }).execute();
      const id = await record(tx, request, scope, { competitionId, roundId: a.round_id, groupId: a.group_id, kind: "makeup_attempt", reason: body.reason, before: { status: a.status }, after: { status: "invalidated", makeupAvailableUntil: until }, affected: { attemptIds: [a.id], registrationId: a.registration_id } });
      const versions = await recalculateAffected(tx, request, scope.tenant.id, competitionId, a.round_id, [a.group_id], scope.auth.userId, `Make-up granted: ${body.reason}`);
      return { id, until, versions };
    });
    return reply.status(201).send({ actionId: out.id, availableUntil: out.until, recalculatedVersions: out.versions });
  });

  /**
   * Fix a faulty question across a round (optionally one group):
   *   disable     – removed from every attempt's score and maximum
   *   full_credit – everyone gets full points for it
   *   replace     – removed from scoring; new attempts get the replacement
   * Every affected submitted attempt is re-scored, keeping its old score.
   */
  app.post("/questions", async (request, reply) => {
    const { scope, competitionId } = await context(request);
    const body = parse(
      z.object({ roundId: zUuid, groupId: zUuid.optional(), itemId: zUuid, action: z.enum(["disable", "full_credit", "replace"]), replacementItemId: zUuid.optional(), reason: zReason })
        .refine((b) => (b.action === "replace") === (b.replacementItemId !== undefined), { message: "replacementItemId is required for replace only", path: ["replacementItemId"] }),
      request.body,
    );
    const out = await withContext(db, scope.db, async (tx) => {
      await roundOf(tx, competitionId, body.roundId);
      const existing = await tx.selectFrom("question_adjustments").select(["id", "kind"]).where("round_id", "=", body.roundId).where("item_id", "=", body.itemId).execute();
      if (existing.length) throw new AppError("CONFLICT", { reason: "question_already_adjusted", kind: existing[0]!.kind });
      const kind = body.action === "disable" ? "disable_question" : body.action === "full_credit" ? "full_credit" : "replace_question";
      let q = tx.selectFrom("attempts").selectAll().where("competition_id", "=", competitionId).where("round_id", "=", body.roundId).where("status", "=", "submitted").where("kind", "=", "official");
      if (body.groupId) q = q.where("group_id", "=", body.groupId);
      const attempts = (await q.forUpdate().execute()).filter((a) => (a.question_set as Array<{ itemId: string }>).some((x) => x.itemId === body.itemId));
      const actionId = await record(tx, request, scope, { competitionId, roundId: body.roundId, groupId: body.groupId ?? null, kind, reason: body.reason, before: { itemId: body.itemId }, after: { action: body.action, replacementItemId: body.replacementItemId ?? null }, affected: { attemptIds: attempts.map((a) => a.id) } });
      await tx.insertInto("question_adjustments").values({ tenant_id: scope.tenant.id, competition_id: competitionId, round_id: body.roundId, group_id: body.groupId ?? null, item_id: body.itemId, kind: body.action === "disable" ? "disabled" : body.action === "full_credit" ? "full_credit" : "replaced", replacement_item_id: body.replacementItemId ?? null, emergency_action_id: actionId }).execute();
      const rescored = [];
      for (const a of attempts) {
        const r = await rescoreAttempt(tx, a as Attempt, `Question ${body.action}: ${body.reason}`, actionId);
        rescored.push({ attemptId: a.id, before: r.before?.totalScore ?? null, after: r.after.totalScore });
      }
      const groups = body.groupId ? [body.groupId] : null;
      const versions = await recalculateAffected(tx, request, scope.tenant.id, competitionId, body.roundId, groups, scope.auth.userId, `Question ${body.action}: ${body.reason}`);
      return { actionId, rescored, versions };
    });
    return reply.status(201).send({ actionId: out.actionId, rescored: out.rescored, recalculatedVersions: out.versions });
  });

  /** Cancel a round: running and submitted attempts are invalidated; it can no longer be started or published. */
  app.post("/cancel-round", async (request, reply) => {
    const { scope, competitionId } = await context(request);
    const body = parse(z.object({ roundId: zUuid, reason: zReason }), request.body);
    const out = await withContext(db, scope.db, async (tx) => {
      await roundOf(tx, competitionId, body.roundId);
      const already = await tx.selectFrom("round_states").select("status").where("competition_id", "=", competitionId).where("round_id", "=", body.roundId).executeTakeFirst();
      if (already) throw new AppError("CONFLICT", { reason: "already_cancelled" });
      const attempts = await tx.updateTable("attempts").set({ status: "invalidated", invalidated_at: new Date(), invalidated_reason: `Round cancelled: ${body.reason}` }).where("competition_id", "=", competitionId).where("round_id", "=", body.roundId).where("status", "in", ["in_progress", "paused", "submitted"]).returning("id").execute();
      const actionId = await record(tx, request, scope, { competitionId, roundId: body.roundId, groupId: null, kind: "cancel_round", reason: body.reason, before: { status: "active" }, after: { status: "cancelled" }, affected: { attemptIds: attempts.map((a) => a.id) } });
      await tx.insertInto("round_states").values({ tenant_id: scope.tenant.id, competition_id: competitionId, round_id: body.roundId, status: "cancelled", emergency_action_id: actionId }).execute();
      // Open result versions for the round can no longer be approved.
      await tx.updateTable("result_versions").set({ status: "discarded" }).where("competition_id", "=", competitionId).where("round_id", "=", body.roundId).where("status", "in", ["draft", "in_review", "approved"]).execute();
      return { actionId, invalidated: attempts.length };
    });
    return reply.status(201).send(out);
  });
}
