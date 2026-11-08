import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, type QuestionRef } from "@cos/core";
import { withContext } from "@cos/db";
import { loadPool } from "../lib/runtime.ts";
import { permissionsInCompetition, resolveTenantScope, type TenantScope } from "../lib/tenant-scope.ts";
import { parse, zUuid } from "../lib/validation.ts";

/** Organizer and judge views of attempts and their integrity signals. */
export async function adminRuntimeRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const scopeOf = (request: FastifyRequest) => resolveTenantScope(db, request, parse(z.object({ tenantId: zUuid }).passthrough(), request.params).tenantId);
  const canReview = (scope: TenantScope, competitionId: string) => {
    const p = permissionsInCompetition(scope, competitionId);
    if (!p.has("review.submit") && !p.has("competitions.manage")) throw new AppError("FORBIDDEN");
  };

  app.get("/competitions/:competitionId/attempts", async (request) => {
    const scope = await scopeOf(request);
    const { competitionId } = parse(z.object({ competitionId: zUuid }).passthrough(), request.params);
    canReview(scope, competitionId);
    const q = parse(
      z.object({
        roundId: zUuid.optional(),
        groupId: zUuid.optional(),
        status: z.enum(["in_progress", "paused", "submitted", "invalidated"]).optional(),
        minRisk: z.coerce.number().int().min(0).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    const rows = await withContext(db, scope.db, (tx) => {
      let query = tx
        .selectFrom("attempts as a")
        .leftJoin("risk_cases as rc", "rc.attempt_id", "a.id")
        .select(["a.id", "a.round_id", "a.group_id", "a.student_id", "a.registration_id", "a.kind", "a.status", "a.attempt_number", "a.started_at", "a.deadline_at", "a.submitted_at", "a.submit_reason", "a.score", "a.score_status", "a.risk_score", "a.makeup_of", "rc.status as case_status"])
        .where("a.competition_id", "=", competitionId)
        .orderBy("a.started_at", "desc")
        .limit(q.limit)
        .offset(q.offset);
      if (q.roundId) query = query.where("a.round_id", "=", q.roundId);
      if (q.groupId) query = query.where("a.group_id", "=", q.groupId);
      if (q.status) query = query.where("a.status", "=", q.status);
      if (q.minRisk !== undefined) query = query.where("a.risk_score", ">=", q.minRisk);
      return query.execute();
    });
    return {
      attempts: rows.map((a) => ({
        id: a.id, roundId: a.round_id, groupId: a.group_id, studentId: a.student_id, registrationId: a.registration_id, kind: a.kind, status: a.status,
        attemptNumber: a.attempt_number, startedAt: a.started_at, deadlineAt: a.deadline_at, submittedAt: a.submitted_at, submitReason: a.submit_reason,
        score: a.score, scoreStatus: a.score_status, riskScore: a.risk_score, riskCaseStatus: a.case_status, makeupOf: a.makeup_of,
      })),
    };
  });

  /** Everything a reviewer needs: questions as shown, answers with grades, sessions, and the signal timeline. */
  app.get("/attempts/:attemptId", async (request) => {
    const scope = await scopeOf(request);
    const { attemptId } = parse(z.object({ attemptId: zUuid }).passthrough(), request.params);
    return withContext(db, scope.db, async (tx) => {
      const a = await tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).executeTakeFirst();
      if (!a) throw new AppError("NOT_FOUND");
      canReview(scope, a.competition_id);
      const refs = a.question_set as QuestionRef[];
      const pool = await loadPool(tx, a.content_version_id, refs.map((r) => r.itemId));
      const [answers, sessions, events, riskCase] = await Promise.all([
        tx.selectFrom("attempt_answers").selectAll().where("attempt_id", "=", attemptId).execute(),
        tx.selectFrom("attempt_sessions").selectAll().where("attempt_id", "=", attemptId).orderBy("started_at").execute(),
        tx.selectFrom("integrity_events").selectAll().where("attempt_id", "=", attemptId).orderBy("server_time").execute(),
        tx.selectFrom("risk_cases").selectAll().where("attempt_id", "=", attemptId).executeTakeFirst(),
      ]);
      const byItem = new Map(answers.map((x) => [x.item_id, x]));
      return {
        attempt: {
          id: a.id, competitionId: a.competition_id, roundId: a.round_id, groupId: a.group_id, studentId: a.student_id, kind: a.kind, status: a.status,
          attemptNumber: a.attempt_number, seed: a.seed, contentVersionId: a.content_version_id, contentLocale: a.content_locale,
          startedAt: a.started_at, deadlineAt: a.deadline_at, extensionSeconds: a.extension_seconds, submittedAt: a.submitted_at, submitReason: a.submit_reason,
          score: a.score, scoreStatus: a.score_status, riskScore: a.risk_score, makeupOf: a.makeup_of, invalidatedReason: a.invalidated_reason,
        },
        questions: refs.map((ref, i) => {
          const p = pool.get(ref.itemId)!;
          const ans = byItem.get(ref.itemId);
          return {
            position: i + 1, itemId: ref.itemId, externalKey: p.pool.externalKey, contentType: p.pool.contentType, order: ref.order,
            response: ans?.response ?? null, grade: ans?.grade ?? null, timeSpentMs: ans?.time_spent_ms ?? null, changeCount: ans?.change_count ?? 0, lateSync: ans?.late_sync ?? false, savedAt: ans?.saved_at ?? null,
          };
        }),
        sessions: sessions.map((s) => ({ id: s.id, deviceId: s.device_id, fingerprintHash: s.fingerprint_hash, ip: s.ip, userAgent: s.user_agent, status: s.status, startedAt: s.started_at, lastSeenAt: s.last_seen_at })),
        events: events.map((e) => ({ id: e.id, source: e.source, type: e.type, details: e.details, clientTime: e.client_time, serverTime: e.server_time, sessionId: e.session_id })),
        riskCase: riskCase ? { id: riskCase.id, status: riskCase.status, riskScore: riskCase.risk_score, signals: riskCase.signals, createdAt: riskCase.created_at } : null,
      };
    });
  });
}
