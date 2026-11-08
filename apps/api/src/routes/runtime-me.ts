import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { AppError, CLIENT_EVENT_TYPES, CompetitionConfigSchema, remainingAttempts } from "@cos/core";
import { resultsVisibleNow } from "./catalog.ts";
import { ANONYMOUS, withContext, type Attempt, type DbContext } from "@cos/db";
import { requireAuth, type AuthInfo } from "../lib/auth.ts";
import {
  attemptState,
  closeIfExpired,
  loadVersionContext,
  openSession,
  recordClientEvents,
  resumePaused,
  saveAnswers,
  startOrResumeAttempt,
  submitAttempt,
  touchSession,
} from "../lib/runtime.ts";
import { parse, zUuid } from "../lib/validation.ts";

const personal = (auth: AuthInfo): DbContext => ({ ...ANONYMOUS, userId: auth.userId });
/**
 * After the participant is authorized for an attempt, runtime work runs in
 * the competition's tenant on their behalf (audit entries carry their id).
 */
const runtimeContext = (tenantId: string, auth: AuthInfo): DbContext => ({ userId: auth.userId, tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] });

const Device = { deviceId: z.string().min(8).max(100), fingerprint: z.string().max(200).optional() };
const StartBody = z.object({ registrationId: zUuid, roundId: zUuid, ...Device });
const SessionQuery = z.object({ sessionId: zUuid });
const AnswersBody = z.object({
  sessionId: zUuid,
  answers: z
    .array(
      z.object({
        itemId: zUuid,
        response: z.record(z.string(), z.unknown()).nullable(),
        clientSeq: z.number().int().min(1),
        clientSavedAt: z.iso.datetime({ offset: true }).nullable().default(null),
        timeSpentMs: z.number().int().min(0).max(86_400_000).default(0),
      }),
    )
    .min(1)
    .max(200),
});
const EventsBody = z.object({
  sessionId: zUuid,
  events: z.array(z.object({ type: z.enum(CLIENT_EVENT_TYPES), at: z.iso.datetime({ offset: true }).nullable().default(null), details: z.record(z.string(), z.unknown()).optional() })).max(100),
});

/**
 * The participant runtime. Students use their own login; a parent may run an
 * attempt for a young child. Every request carries the session it belongs to.
 */
export async function meRuntimeRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  /** Authorize: the attempt must belong to me or my child (RLS in my personal context). */
  async function myAttempt(auth: AuthInfo, attemptId: string): Promise<Attempt> {
    const a = await withContext(db, personal(auth), (tx) => tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).executeTakeFirst());
    if (!a) throw new AppError("NOT_FOUND");
    return a as Attempt;
  }

  async function withAttempt<T>(request: FastifyRequest, attemptId: string, fn: (tx: Parameters<Parameters<typeof withContext>[2]>[0], attempt: Attempt, now: Date) => Promise<T>): Promise<T> {
    const auth = requireAuth(request);
    const owned = await myAttempt(auth, attemptId);
    const now = new Date();
    return withContext(db, runtimeContext(owned.tenant_id, auth), async (tx) => {
      const current = (await tx.selectFrom("attempts").selectAll().where("id", "=", attemptId).forUpdate().executeTakeFirstOrThrow()) as Attempt;
      const attempt = await closeIfExpired(tx, request, current, now);
      return fn(tx, attempt, now);
    });
  }

  /** Rounds a student can take now or later, with attempts used and left. */
  app.get("/rounds", async (request) => {
    const auth = requireAuth(request);
    const { studentId } = parse(z.object({ studentId: zUuid.optional() }), request.query);
    const regs = await withContext(db, personal(auth), async (tx) => {
      let q = tx
        .selectFrom("registrations as r")
        .innerJoin("competitions as c", "c.id", "r.competition_id")
        .innerJoin("competition_versions as v", "v.id", "c.current_version_id")
        .select(["r.id", "r.tenant_id", "r.student_id", "r.group_id", "r.competition_id", "c.name as competition_name", "v.config"])
        .where("r.status", "=", "confirmed")
        .where((eb) => eb.or([eb(eb.ref("r.student_id"), "in", eb.selectFrom("students").select("id").where("user_id", "=", auth.userId)), eb(eb.ref("r.student_id"), "in", eb.selectFrom("parent_children").select("student_id").where("parent_user_id", "=", auth.userId))]));
      if (studentId) q = q.where("r.student_id", "=", studentId);
      const rows = await q.execute();
      const attempts = rows.length ? await tx.selectFrom("attempts").select(["registration_id", "round_id", "status", "id"]).where("registration_id", "in", rows.map((r) => r.id)).execute() : [];
      return { rows, attempts };
    });
    const now = Date.now();
    const out = [];
    for (const r of regs.rows) {
      const config = CompetitionConfigSchema.parse(r.config);
      const grants = await withContext(db, runtimeContext(r.tenant_id, auth), (tx) =>
        tx.selectFrom("attempt_grants").select(["round_id"]).where("registration_id", "=", r.id).execute(),
      );
      for (const round of config.rounds) {
        const rg = round.groups.find((g) => g.groupId === r.group_id && g.enabled);
        if (!rg) continue;
        const mine = regs.attempts.filter((a) => a.registration_id === r.id && a.round_id === round.id);
        const running = mine.find((a) => a.status === "in_progress" || a.status === "paused");
        const state = now < Date.parse(round.opensAt) ? "upcoming" : now >= Date.parse(round.closesAt) ? "closed" : "open";
        out.push({
          registrationId: r.id,
          studentId: r.student_id,
          competitionId: r.competition_id,
          competitionName: r.competition_name,
          round: { id: round.id, key: round.key, name: round.name, kind: round.kind, opensAt: round.opensAt, closesAt: round.closesAt, durationSeconds: rg.durationSeconds },
          state,
          entry: round.entry.type,
          attemptsUsed: mine.length,
          attemptsLeft: remainingAttempts(round.attemptPolicy, mine.length, grants.filter((g) => g.round_id === round.id).length),
          runningAttemptId: running?.id ?? null,
        });
      }
    }
    return { rounds: out };
  });

  /** Start (or resume) an attempt on this device. */
  app.post("/attempts", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parse(StartBody, request.body);
    const reg = await withContext(db, personal(auth), (tx) =>
      tx
        .selectFrom("registrations")
        .select(["id", "tenant_id", "competition_id", "group_id", "student_id", "status", "content_locale"])
        .where("id", "=", body.registrationId)
        .where((eb) => eb.or([eb(eb.ref("student_id"), "in", eb.selectFrom("students").select("id").where("user_id", "=", auth.userId)), eb(eb.ref("student_id"), "in", eb.selectFrom("parent_children").select("student_id").where("parent_user_id", "=", auth.userId))]))
        .executeTakeFirst(),
    );
    if (!reg) throw new AppError("NOT_FOUND");
    const now = new Date();
    const result = await withContext(db, runtimeContext(reg.tenant_id, auth), async (tx) => {
      const { attempt, resumed } = await startOrResumeAttempt(tx, request, { registration: reg, roundId: body.roundId, actorUserId: auth.userId, now });
      const current = await closeIfExpired(tx, request, attempt, now);
      if (current.status === "submitted") return { attempt: current, resumed, session: null };
      const { rg } = await loadVersionContext(tx, current.competition_version_id, current.round_id, current.group_id);
      const session = await openSession(tx, current, { deviceId: body.deviceId, fingerprint: body.fingerprint ?? null, ip: request.ip, userAgent: request.headers["user-agent"] ?? null }, rg.integrity.maxDevices, now);
      return { attempt: current, resumed, session };
    });
    if (result.session && "refused" in result.session) throw new AppError("CONFLICT", { reason: "device_limit", allowed: result.session.refused.allowed });
    const state = await withContext(db, runtimeContext(reg.tenant_id, auth), (tx) => attemptState(tx, result.attempt, now));
    const sessionId = result.session && !("refused" in result.session) ? result.session.id : null;
    return reply.status(result.resumed ? 200 : 201).send({ sessionId, resumed: result.resumed, ...state });
  });

  /** Resume after refresh or reconnect: full state from the server, including saved answers. */
  app.get("/attempts/:attemptId", async (request) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const { sessionId } = parse(SessionQuery.partial(), request.query);
    return withAttempt(request, attemptId, async (tx, attempt, now) => {
      if (sessionId && attempt.status !== "submitted") await touchSession(tx, attempt, sessionId, request.ip, now);
      return attemptState(tx, attempt, now);
    });
  });

  /** Autosave. Accepts a batch (e.g. answers queued while offline); never overwrites newer with older. */
  app.put("/attempts/:attemptId/answers", async (request) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const body = parse(AnswersBody, request.body);
    return withAttempt(request, attemptId, async (tx, attempt, now) => {
      if (attempt.status === "submitted" || attempt.status === "invalidated") throw new AppError("CONFLICT", { reason: "attempt_closed", status: attempt.status });
      await touchSession(tx, attempt, body.sessionId, request.ip, now);
      const result = await saveAnswers(tx, attempt, body.sessionId, body.answers, now);
      return { ...result, serverTime: now, remainingSeconds: Math.max(0, Math.ceil((attempt.deadline_at.getTime() - now.getTime()) / 1000)) };
    });
  });

  app.post("/attempts/:attemptId/heartbeat", async (request) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const { sessionId } = parse(SessionQuery, request.body);
    return withAttempt(request, attemptId, async (tx, attempt, now) => {
      if (attempt.status !== "submitted") await touchSession(tx, attempt, sessionId, request.ip, now);
      return { status: attempt.status, serverTime: now, deadlineAt: attempt.deadline_at, remainingSeconds: Math.max(0, Math.ceil((attempt.deadline_at.getTime() - now.getTime()) / 1000)) };
    });
  });

  /** Browser integrity signals (tab switches, fullscreen exits, copy/paste…). Returns the action to take. */
  app.post("/attempts/:attemptId/events", async (request) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const body = parse(EventsBody, request.body);
    return withAttempt(request, attemptId, async (tx, attempt, now) => {
      if (attempt.status === "submitted") return { action: "none" as const, status: attempt.status };
      await touchSession(tx, attempt, body.sessionId, request.ip, now);
      const res = await recordClientEvents(tx, request, attempt, body.sessionId, body.events, now);
      return { ...res, status: res.action === "submitted" ? "submitted" : res.action === "pause" ? "paused" : attempt.status };
    });
  });

  /** Continue after a pause (e.g. fullscreen restored). The timer did not stop. */
  app.post("/attempts/:attemptId/resume", async (request) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const { sessionId } = parse(SessionQuery, request.body);
    return withAttempt(request, attemptId, async (tx, attempt, now) => {
      await touchSession(tx, attempt, sessionId, request.ip, now);
      await resumePaused(tx, attempt);
      return attemptState(tx, { ...attempt, status: "in_progress" }, now);
    });
  });

  app.post("/attempts/:attemptId/submit", async (request) => {
    const { attemptId } = parse(z.object({ attemptId: zUuid }), request.params);
    const { sessionId } = parse(SessionQuery, request.body);
    return withAttempt(request, attemptId, async (tx, attempt, now) => {
      if (attempt.status === "submitted" || attempt.status === "invalidated") return attemptState(tx, attempt, now);
      await touchSession(tx, attempt, sessionId, request.ip, now);
      const done = await submitAttempt(tx, request, attempt, "participant", now);
      return attemptState(tx, done, now);
    });
  });

  app.get("/attempts", async (request) => {
    const auth = requireAuth(request);
    const { studentId } = parse(z.object({ studentId: zUuid.optional() }), request.query);
    const rows = await withContext(db, personal(auth), (tx) => {
      let q = tx.selectFrom("attempts").select(["id", "competition_id", "round_id", "group_id", "student_id", "kind", "status", "attempt_number", "started_at", "submitted_at", "submit_reason"]).orderBy("started_at", "desc");
      if (studentId) q = q.where("student_id", "=", studentId);
      return q.execute();
    });
    return {
      attempts: rows.map((a) => ({ id: a.id, competitionId: a.competition_id, roundId: a.round_id, groupId: a.group_id, studentId: a.student_id, kind: a.kind, status: a.status, attemptNumber: a.attempt_number, startedAt: a.started_at, submittedAt: a.submitted_at, submitReason: a.submit_reason })),
    };
  });

  /** My (or my children's) official results: published versions only, following the competition's publication setting. */
  app.get("/results", async (request) => {
    const auth = requireAuth(request);
    const { studentId } = parse(z.object({ studentId: zUuid.optional() }), request.query);
    return withContext(db, personal(auth), async (tx) => {
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
          .select(["c.name", "c.results_publication", "cv.config"])
          .where("c.id", "=", v.competition_id)
          .executeTakeFirst();
        if (!comp || !resultsVisibleNow(comp.results_publication, CompetitionConfigSchema.parse(comp.config))) continue;
        out.push({
          competitionId: v.competition_id, competitionName: comp.name, roundId: v.round_id, groupId: v.group_id, versionNumber: v.version_number, publishedAt: v.published_at,
          studentId: e.student_id, status: e.status, totalScore: e.total_score === null ? null : Number(e.total_score), rank: e.rank, tied: (e.tied_with ?? 1) > 1, qualified: e.qualified,
          scopeRanks: e.scope_ranks,
        });
      }
      return { results: out };
    });
  });
}
