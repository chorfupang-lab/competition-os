import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "@cos/core";
import { withContext, type Attempt, type Tx } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { recalculateAffected } from "../lib/results.ts";
import { rescoreAttempt } from "../lib/runtime.ts";
import { permissionsInCompetition, requirePermission, resolveTenantScope, type TenantScope } from "../lib/tenant-scope.ts";
import { parse, zReason, zUuid } from "../lib/validation.ts";

/**
 * AI oversight for organizers and judges: confirming AI-suggested grades
 * (AI never sets an official score by itself), AI settings, and usage/cost.
 */
export async function aiAdminRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const scopeOf = (request: FastifyRequest) => resolveTenantScope(db, request, parse(z.object({ tenantId: zUuid }).passthrough(), request.params).tenantId);

  /** Turn AI suggestions into manual grades, recorded as the judge's decision. */
  async function confirmSuggestions(tx: Tx, request: FastifyRequest, scope: TenantScope, attempt: Attempt, itemIds: string[] | null, note: string) {
    const answers = await tx.selectFrom("attempt_answers").selectAll().where("attempt_id", "=", attempt.id).execute();
    const confirmed: Array<{ itemId: string; fraction: number }> = [];
    for (const a of answers) {
      const g = a.grade as { manual?: boolean; ai?: { suggestedFraction: number; assessmentId: string } } | null;
      if (!g?.ai || g.manual || (itemIds && !itemIds.includes(a.item_id))) continue;
      const f = g.ai.suggestedFraction;
      const grade = { outcome: f >= 1 ? "correct" : f <= 0 ? "incorrect" : "partial", fraction: f, manual: true, source: "ai_suggestion_confirmed", gradedBy: scope.auth.userId, note, ai: g.ai };
      await tx.updateTable("attempt_answers").set({ grade: JSON.stringify(grade) }).where("attempt_id", "=", attempt.id).where("item_id", "=", a.item_id).execute();
      confirmed.push({ itemId: a.item_id, fraction: f });
    }
    if (!confirmed.length) return { confirmed, score: null };
    const r = await rescoreAttempt(tx, attempt, `AI suggestions confirmed: ${note}`, null);
    await audit(tx, request, { tenantId: scope.tenant.id, actorUserId: scope.auth.userId, action: "grading.ai_confirmed", targetType: "attempt", targetId: attempt.id, reason: note, before: { score: r.before }, after: { confirmed, score: r.after } });
    return { confirmed, score: r.after, scoreStatus: r.scoreStatus };
  }

  app.post("/attempts/:attemptId/grades/accept-ai", async (request) => {
    const scope = await scopeOf(request);
    const { attemptId } = parse(z.object({ attemptId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ itemIds: z.array(zUuid).max(500).optional(), note: zReason }), request.body);
    return withContext(db, scope.db, async (tx) => {
      const a = await tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).where("tenant_id", "=", scope.tenant.id).forUpdate().executeTakeFirst();
      if (!a) throw new AppError("NOT_FOUND");
      if (!permissionsInCompetition(scope, a.competition_id).has("review.submit")) throw new AppError("FORBIDDEN");
      if (a.status !== "submitted") throw new AppError("CONFLICT", { reason: "attempt_not_submitted" });
      const out = await confirmSuggestions(tx, request, scope, a as Attempt, body.itemIds ?? null, body.note);
      const versions = out.confirmed.length ? await recalculateAffected(tx, request, scope.tenant.id, a.competition_id, a.round_id, [a.group_id], scope.auth.userId, "AI suggestions confirmed") : [];
      return { ...out, recalculatedVersions: versions };
    });
  });

  /** Confirm every pending AI suggestion in a round (e.g. after spot-checking a sample). */
  app.post("/competitions/:competitionId/ai-suggestions/accept", async (request) => {
    const scope = await scopeOf(request);
    const { competitionId } = parse(z.object({ competitionId: zUuid }).passthrough(), request.params);
    if (!permissionsInCompetition(scope, competitionId).has("review.submit")) throw new AppError("FORBIDDEN");
    const body = parse(z.object({ roundId: zUuid, groupId: zUuid.optional(), note: zReason }), request.body);
    return withContext(db, scope.db, async (tx) => {
      let q = tx.selectFrom("attempts").selectAll().where("competition_id", "=", competitionId).where("round_id", "=", body.roundId).where("status", "=", "submitted").where("score_status", "=", "pending_manual");
      if (body.groupId) q = q.where("group_id", "=", body.groupId);
      const attempts = await q.forUpdate().execute();
      let confirmed = 0;
      const groups = new Set<string>();
      for (const a of attempts) {
        const out = await confirmSuggestions(tx, request, scope, a as Attempt, null, body.note);
        if (out.confirmed.length) {
          confirmed += out.confirmed.length;
          groups.add(a.group_id);
        }
      }
      const versions = groups.size ? await recalculateAffected(tx, request, scope.tenant.id, competitionId, body.roundId, [...groups], scope.auth.userId, "AI suggestions confirmed in bulk") : [];
      return { attempts: attempts.length, confirmed, recalculatedVersions: versions };
    });
  });

  app.patch("/competitions/:competitionId/ai-settings", async (request) => {
    const scope = await scopeOf(request);
    const { competitionId } = parse(z.object({ competitionId: zUuid }).passthrough(), request.params);
    if (!permissionsInCompetition(scope, competitionId).has("competitions.manage")) throw new AppError("FORBIDDEN");
    const body = parse(
      z.object({
        voiceRetentionDays: z.union([z.literal(0), z.literal(30), z.literal(90)]).optional(),
        passportComparisons: z.array(z.enum(["group_average", "age_benchmark", "percentile", "previous_attempt"])).max(4).optional(),
        aiFeedbackEnabled: z.boolean().optional(),
        reason: z.string().trim().max(2000).optional(),
      }),
      request.body,
    );
    // Keeping children's voice recordings is a privacy decision and needs a stated reason.
    if (body.voiceRetentionDays && (body.reason ?? "").length < 3) throw new AppError("REASON_REQUIRED", { field: "reason" });
    await withContext(db, scope.db, async (tx) => {
      const changes = {
        ...(body.voiceRetentionDays !== undefined && { voice_retention_days: body.voiceRetentionDays }),
        ...(body.passportComparisons && { passport_comparisons: [...new Set(body.passportComparisons)] }),
        ...(body.aiFeedbackEnabled !== undefined && { ai_feedback_enabled: body.aiFeedbackEnabled }),
      };
      if (!Object.keys(changes).length) return;
      const r = await tx.updateTable("competitions").set(changes).where("id", "=", competitionId).where("tenant_id", "=", scope.tenant.id).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new AppError("NOT_FOUND");
      await audit(tx, request, { tenantId: scope.tenant.id, actorUserId: scope.auth.userId, action: "competition.ai_settings_updated", targetType: "competition", targetId: competitionId, reason: body.reason ?? null, after: body });
    });
    return { ok: true };
  });

  /** AI usage and estimated cost, by kind / provider / model, plus job health. */
  app.get("/ai/usage", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "analytics.read");
    const q = parse(z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), competitionId: zUuid.optional() }), request.query);
    return withContext(db, scope.db, async (tx) => {
      let u = tx.selectFrom("ai_usage").select(["kind", "provider", "model", (eb) => eb.fn.countAll<string>().as("n"), (eb) => eb.fn.sum<string>("cost_micros").as("cost")]).groupBy(["kind", "provider", "model"]);
      if (q.from) u = u.where("created_at", ">=", new Date(q.from));
      if (q.to) u = u.where("created_at", "<", new Date(q.to));
      if (q.competitionId) u = u.where("competition_id", "=", q.competitionId);
      const usage = await u.execute();
      let j = tx.selectFrom("ai_jobs").select(["kind", "status", (eb) => eb.fn.countAll<string>().as("n")]).groupBy(["kind", "status"]);
      if (q.competitionId) j = j.where("competition_id", "=", q.competitionId);
      const jobs = await j.execute();
      return {
        usage: usage.map((x) => ({ kind: x.kind, provider: x.provider, model: x.model, calls: Number(x.n), estimatedCostUsd: Number(x.cost ?? 0) / 1e6 })),
        totalEstimatedCostUsd: usage.reduce((s, x) => s + Number(x.cost ?? 0), 0) / 1e6,
        jobs: jobs.map((x) => ({ kind: x.kind, status: x.status, count: Number(x.n) })),
      };
    });
  });
}
