import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import {
  AppError,
  CompetitionConfigSchema,
  CONNECTION_GAP_MS,
  RISK_FLAG_THRESHOLD,
  attemptDeadline,
  buildQuestionSet,
  decideAnswerSave,
  detectAnswerPattern,
  detectAnswerSimilarity,
  detectImpossibleSpeed,
  gradeResponse,
  isPastDeadline,
  participantView,
  remainingAttempts,
  remainingSeconds,
  riskScore,
  scoreAttempt,
  toGradedItem,
  type AnswerFact,
  type CompetitionConfig,
  type ContentItemData,
  type GradeOutcome,
  type GradedItem,
  type PoolItem,
  type QuestionRef,
  type Response as ItemResponse,
  type RoundConfig,
  type RoundGroupConfig,
  type TranslationStrings,
} from "@cos/core";
import type { Attempt, AttemptSession, Tx } from "@cos/db";
import { audit } from "./audit.ts";
import { newId } from "./crypto.ts";

/**
 * Competition runtime. Every function here runs inside the competition's
 * tenant as the system actor, AFTER the route has authorized the participant
 * in their personal context. Time always comes from the server.
 */

export interface VersionContext {
  config: CompetitionConfig;
  round: RoundConfig;
  rg: RoundGroupConfig;
}

export async function loadVersionContext(tx: Tx, competitionVersionId: string, roundId: string, groupId: string): Promise<VersionContext> {
  const v = await tx.selectFrom("competition_versions").select("config").where("id", "=", competitionVersionId).executeTakeFirstOrThrow();
  const config = CompetitionConfigSchema.parse(v.config);
  const round = config.rounds.find((r) => r.id === roundId);
  const rg = round?.groups.find((g) => g.groupId === groupId);
  if (!round || !rg) throw new AppError("NOT_FOUND", { field: "roundId" });
  return { config, round, rg };
}

interface Snapshot {
  item: ContentItemData & { id: string };
  translations: Record<string, TranslationStrings>;
}

export async function loadPool(tx: Tx, contentVersionId: string, itemIds?: string[]): Promise<Map<string, { pool: PoolItem; snapshot: Snapshot }>> {
  let q = tx.selectFrom("content_version_items").select(["item_id", "external_key", "content_type", "difficulty", "category", "tags", "locales", "snapshot"]).where("version_id", "=", contentVersionId);
  if (itemIds) {
    if (itemIds.length === 0) return new Map();
    q = q.where("item_id", "in", itemIds);
  }
  const rows = await q.execute();
  return new Map(
    rows.map((r) => {
      const snapshot = r.snapshot as Snapshot;
      return [
        r.item_id,
        {
          snapshot,
          pool: { itemId: r.item_id, externalKey: r.external_key, contentType: r.content_type as PoolItem["contentType"], difficulty: r.difficulty, category: r.category, tags: r.tags, locales: r.locales, item: snapshot.item },
        },
      ];
    }),
  );
}

async function serverEvent(tx: Tx, attempt: Pick<Attempt, "id" | "tenant_id">, sessionId: string | null, type: string, details: Record<string, unknown> = {}) {
  await tx.insertInto("integrity_events").values({ tenant_id: attempt.tenant_id, attempt_id: attempt.id, session_id: sessionId, source: "server", type, details: JSON.stringify(details), client_time: null }).execute();
}

// ---------------------------------------------------------------- start

export interface StartInput {
  registration: { id: string; tenant_id: string; competition_id: string; group_id: string; student_id: string; status: string; content_locale: string };
  roundId: string;
  actorUserId: string;
  now: Date;
}

/** Start an attempt, or return the one already running (refresh / reconnect resumes it). */
export async function startOrResumeAttempt(tx: Tx, request: FastifyRequest, input: StartInput): Promise<{ attempt: Attempt; resumed: boolean }> {
  const { registration: reg, now } = input;
  await sql`select pg_advisory_xact_lock(hashtext(${`attempt:${reg.id}:${input.roundId}`}))`.execute(tx);
  const running = await tx.selectFrom("attempts").selectAll().where("registration_id", "=", reg.id).where("round_id", "=", input.roundId).where("status", "in", ["in_progress", "paused"]).executeTakeFirst();
  if (running) return { attempt: running as Attempt, resumed: true };

  if (reg.status !== "confirmed") throw new AppError("CONFLICT", { reason: "registration_not_confirmed", status: reg.status });
  const comp = await tx.selectFrom("competitions").select(["current_version_id", "status"]).where("id", "=", reg.competition_id).executeTakeFirstOrThrow();
  if (comp.status !== "published" || !comp.current_version_id) throw new AppError("CONFLICT", { reason: "competition_not_running" });
  const { round, rg } = await loadVersionContext(tx, comp.current_version_id, input.roundId, reg.group_id);
  if (!rg.enabled) throw new AppError("CONFLICT", { reason: "group_not_in_round" });
  if (round.entry.type !== "registration") throw new AppError("CONFLICT", { reason: "qualification_not_available", hint: "Qualified entry opens when results are published" });
  if (now < new Date(round.opensAt)) throw new AppError("CONFLICT", { reason: "round_not_open", opensAt: round.opensAt });
  if (now >= new Date(round.closesAt)) throw new AppError("CONFLICT", { reason: "round_closed", closedAt: round.closesAt });
  const contentVersionId = rg.content.contentBankVersionId;
  if (!contentVersionId) throw new AppError("CONFLICT", { reason: "no_content" });

  const { n: used } = await tx.selectFrom("attempts").select((eb) => eb.fn.countAll<string>().as("n")).where("registration_id", "=", reg.id).where("round_id", "=", round.id).executeTakeFirstOrThrow();
  const { n: grants } = await tx.selectFrom("attempt_grants").select((eb) => eb.fn.countAll<string>().as("n")).where("registration_id", "=", reg.id).where("round_id", "=", round.id).executeTakeFirstOrThrow();
  const left = remainingAttempts(round.attemptPolicy, Number(used), Number(grants));
  if (left !== null && left <= 0) throw new AppError("CONFLICT", { reason: "no_attempts_left" });

  const pool = await loadPool(tx, contentVersionId);
  const id = newId();
  const questionSet = buildQuestionSet([...pool.values()].map((p) => p.pool), rg, id);
  if (questionSet.length === 0) throw new AppError("CONFLICT", { reason: "no_content" });
  const makeupOf = Number(grants) > 0
    ? (await tx.selectFrom("attempt_grants").select("replaces_attempt_id").where("registration_id", "=", reg.id).where("round_id", "=", round.id).orderBy("created_at", "desc").executeTakeFirst())?.replaces_attempt_id ?? null
    : null;

  await tx
    .insertInto("attempts")
    .values({
      id,
      tenant_id: reg.tenant_id,
      competition_id: reg.competition_id,
      competition_version_id: comp.current_version_id,
      round_id: round.id,
      group_id: reg.group_id,
      registration_id: reg.id,
      student_id: reg.student_id,
      started_by_user_id: input.actorUserId,
      attempt_number: Number(used) + 1,
      kind: round.kind === "practice" ? "practice" : "official",
      status: "in_progress",
      content_version_id: contentVersionId,
      content_locale: reg.content_locale,
      seed: id,
      question_set: JSON.stringify(questionSet),
      started_at: now,
      deadline_at: attemptDeadline(now, rg.durationSeconds, 0, new Date(round.closesAt)),
      submitted_at: null,
      submit_reason: null,
      score: null,
      invalidated_at: null,
      invalidated_reason: null,
      makeup_of: makeupOf,
      last_activity_at: now,
    })
    .execute();
  await audit(tx, request, {
    tenantId: reg.tenant_id,
    actorUserId: input.actorUserId,
    action: "attempt.started",
    targetType: "attempt",
    targetId: id,
    after: { registrationId: reg.id, roundId: round.id, attemptNumber: Number(used) + 1, questions: questionSet.length, makeupOf },
  });
  return { attempt: (await tx.selectFrom("attempts").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as Attempt, resumed: false };
}

// ---------------------------------------------------------------- sessions and devices

export interface DeviceInfo {
  deviceId: string;
  fingerprint: string | null;
  ip: string;
  userAgent: string | null;
}

/**
 * Attach a device to the attempt. A new device beyond the round's limit is
 * refused (the attempt itself continues on the allowed device). Switching
 * devices or running two at once is recorded for review, never punished.
 */
export async function openSession(tx: Tx, attempt: Attempt, device: DeviceInfo, maxDevices: number | null, now: Date): Promise<AttemptSession | { refused: { allowed: number } }> {
  const sessions = await tx.selectFrom("attempt_sessions").selectAll().where("attempt_id", "=", attempt.id).execute();
  const same = sessions.find((s) => s.device_id === device.deviceId && s.status === "active");
  if (same) {
    await tx.updateTable("attempt_sessions").set({ last_seen_at: now }).where("id", "=", same.id).execute();
    return { ...same, last_seen_at: now } as AttemptSession;
  }
  const devices = new Set(sessions.map((s) => s.device_id));
  if (!devices.has(device.deviceId) && maxDevices !== null && devices.size >= maxDevices) {
    // Recorded and committed; the caller then refuses the request.
    await serverEvent(tx, attempt, null, "device_limit_exceeded", { deviceId: device.deviceId, allowed: maxDevices, ip: device.ip });
    return { refused: { allowed: maxDevices } };
  }
  for (const s of sessions.filter((x) => x.status === "active")) {
    const concurrent = now.getTime() - s.last_seen_at.getTime() < CONNECTION_GAP_MS;
    await tx.updateTable("attempt_sessions").set({ status: "superseded" }).where("id", "=", s.id).execute();
    await serverEvent(tx, attempt, s.id, concurrent ? "concurrent_session" : "device_switch", { fromDevice: s.device_id, toDevice: device.deviceId });
  }
  // The same device or fingerprint used by a different student in this round (shared device or second account).
  const shared = await tx
    .selectFrom("attempt_sessions as s")
    .innerJoin("attempts as a", "a.id", "s.attempt_id")
    .select(["a.student_id"])
    .where("a.round_id", "=", attempt.round_id)
    .where("a.student_id", "!=", attempt.student_id)
    .where((eb) => eb.or([eb("s.device_id", "=", device.deviceId), ...(device.fingerprint ? [eb("s.fingerprint_hash", "=", device.fingerprint)] : [])]))
    .executeTakeFirst();
  const created = await tx
    .insertInto("attempt_sessions")
    .values({ tenant_id: attempt.tenant_id, attempt_id: attempt.id, device_id: device.deviceId, fingerprint_hash: device.fingerprint, ip: device.ip, user_agent: device.userAgent?.slice(0, 500) ?? null })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (shared) await serverEvent(tx, attempt, created.id, "shared_device", { otherStudentId: shared.student_id });
  return created as AttemptSession;
}

/** Validate the caller's session on every runtime request; record long gaps and IP changes. */
export async function touchSession(tx: Tx, attempt: Attempt, sessionId: string, ip: string, now: Date): Promise<AttemptSession> {
  const s = await tx.selectFrom("attempt_sessions").selectAll().where("id", "=", sessionId).where("attempt_id", "=", attempt.id).forUpdate().executeTakeFirst();
  if (!s) throw new AppError("NOT_FOUND", { field: "sessionId" });
  if (s.status !== "active") throw new AppError("CONFLICT", { reason: "session_superseded" });
  const gap = now.getTime() - s.last_seen_at.getTime();
  if (attempt.status !== "submitted" && gap > CONNECTION_GAP_MS) await serverEvent(tx, attempt, s.id, "connection_gap", { seconds: Math.round(gap / 1000) });
  if (s.ip && ip && s.ip !== ip) await serverEvent(tx, attempt, s.id, "ip_change", { from: s.ip, to: ip });
  await tx.updateTable("attempt_sessions").set({ last_seen_at: now, ip }).where("id", "=", s.id).execute();
  await tx.updateTable("attempts").set({ last_activity_at: now }).where("id", "=", attempt.id).execute();
  return s as AttemptSession;
}

// ---------------------------------------------------------------- state

export async function attemptState(tx: Tx, attempt: Attempt, now: Date) {
  const { round, rg } = await loadVersionContext(tx, attempt.competition_version_id, attempt.round_id, attempt.group_id);
  const refs = attempt.question_set as QuestionRef[];
  const pool = await loadPool(tx, attempt.content_version_id, refs.map((r) => r.itemId));
  const answers = await tx.selectFrom("attempt_answers").select(["item_id", "response", "client_seq", "saved_at"]).where("attempt_id", "=", attempt.id).execute();
  const running = attempt.status === "in_progress" || attempt.status === "paused";
  return {
    attempt: {
      id: attempt.id,
      kind: attempt.kind,
      status: attempt.status,
      attemptNumber: attempt.attempt_number,
      roundId: attempt.round_id,
      groupId: attempt.group_id,
      contentLocale: attempt.content_locale,
      startedAt: attempt.started_at,
      deadlineAt: attempt.deadline_at,
      serverTime: now,
      remainingSeconds: running ? remainingSeconds(attempt.deadline_at, now) : 0,
      submittedAt: attempt.submitted_at,
      submitReason: attempt.submit_reason,
    },
    // The browser enforces these; the server records and applies them too.
    policy: { ...rg.integrity, ui: rg.ui, attemptPolicy: round.attemptPolicy },
    // Questions are hidden while paused (e.g. fullscreen left under the "pause" policy).
    questions: attempt.status === "in_progress"
      ? refs.map((ref) => {
          const p = pool.get(ref.itemId)!;
          return participantView(p.snapshot.item, ref, p.snapshot.translations[attempt.content_locale] ?? null);
        })
      : [],
    answers: answers.map((a) => ({ itemId: a.item_id, response: a.response, clientSeq: a.client_seq, savedAt: a.saved_at })),
    result: attempt.status === "submitted" && rg.ui.showScoreOnSubmit && attempt.score
      ? pickScore(attempt.score as Record<string, unknown>, attempt.score_status)
      : null,
  };
}

function pickScore(score: Record<string, unknown>, status: string) {
  return { totalScore: score.totalScore, maxScore: score.maxScore, accuracy: score.accuracy, provisional: true, scoreStatus: status };
}

// ---------------------------------------------------------------- answers

export interface AnswerInput {
  itemId: string;
  response: Record<string, unknown> | null;
  clientSeq: number;
  clientSavedAt: string | null;
  timeSpentMs: number;
}

export async function saveAnswers(tx: Tx, attempt: Attempt, sessionId: string, answers: AnswerInput[], now: Date) {
  if (attempt.status === "paused") throw new AppError("CONFLICT", { reason: "attempt_paused" });
  if (attempt.status !== "in_progress") throw new AppError("CONFLICT", { reason: "attempt_closed", status: attempt.status });
  const itemIds = new Set((attempt.question_set as QuestionRef[]).map((q) => q.itemId));
  const existing = new Map(
    (await tx.selectFrom("attempt_answers").select(["item_id", "client_seq", "change_count"]).where("attempt_id", "=", attempt.id).execute()).map((a) => [a.item_id, a]),
  );
  const saved: string[] = [];
  const rejected: Array<{ itemId: string; reason: string }> = [];
  let lateCount = 0;
  for (const a of answers) {
    if (!itemIds.has(a.itemId)) { rejected.push({ itemId: a.itemId, reason: "not_in_attempt" }); continue; }
    const decision = decideAnswerSave({ now, deadline: attempt.deadline_at, startedAt: attempt.started_at, clientSavedAt: a.clientSavedAt ? new Date(a.clientSavedAt) : null });
    if (!decision.accept) { rejected.push({ itemId: a.itemId, reason: decision.reason }); continue; }
    const prior = existing.get(a.itemId);
    if (prior && prior.client_seq >= a.clientSeq) { rejected.push({ itemId: a.itemId, reason: "stale" }); continue; }
    if (decision.late) lateCount++;
    const values = {
      response: a.response === null ? null : JSON.stringify(a.response),
      client_seq: a.clientSeq,
      client_saved_at: a.clientSavedAt,
      saved_at: now,
      time_spent_ms: a.timeSpentMs,
      late_sync: decision.late,
    };
    if (prior) {
      await tx.updateTable("attempt_answers").set({ ...values, change_count: prior.change_count + 1 }).where("attempt_id", "=", attempt.id).where("item_id", "=", a.itemId).execute();
    } else {
      await tx.insertInto("attempt_answers").values({ tenant_id: attempt.tenant_id, attempt_id: attempt.id, item_id: a.itemId, ...values, grade: null }).execute();
    }
    existing.set(a.itemId, { item_id: a.itemId, client_seq: a.clientSeq, change_count: (prior?.change_count ?? 0) + 1 });
    saved.push(a.itemId);
  }
  if (lateCount) await serverEvent(tx, attempt, sessionId, "late_sync", { answers: lateCount });
  return { saved, rejected };
}

// ---------------------------------------------------------------- integrity events

export interface ClientEvent {
  type: string;
  at: string | null;
  details?: Record<string, unknown> | undefined;
}

/** Record browser signals and apply the fullscreen policy. Returns what the browser must do. */
export async function recordClientEvents(tx: Tx, request: FastifyRequest, attempt: Attempt, sessionId: string, events: ClientEvent[], now: Date) {
  const { rg } = await loadVersionContext(tx, attempt.competition_version_id, attempt.round_id, attempt.group_id);
  if (events.length) {
    await tx
      .insertInto("integrity_events")
      .values(events.map((e) => ({ tenant_id: attempt.tenant_id, attempt_id: attempt.id, session_id: sessionId, source: "client" as const, type: e.type, details: JSON.stringify(e.details ?? {}), client_time: e.at })))
      .execute();
  }
  let action: "none" | "warn" | "pause" | "submitted" = "none";
  if (attempt.status === "in_progress" && events.some((e) => e.type === "fullscreen_exit")) {
    const policy = rg.integrity.fullscreen;
    if (policy === "warn") action = "warn";
    else if (policy === "pause") {
      await tx.updateTable("attempts").set({ status: "paused" }).where("id", "=", attempt.id).execute();
      action = "pause";
    } else if (policy === "auto_submit") {
      await serverEvent(tx, attempt, sessionId, "auto_submitted_policy", { policy });
      await submitAttempt(tx, request, { ...attempt }, "integrity_policy", now);
      action = "submitted";
    }
  }
  if (action !== "submitted") await updateRisk(tx, attempt, rg);
  return { action };
}

export async function resumePaused(tx: Tx, attempt: Attempt): Promise<void> {
  if (attempt.status !== "paused") throw new AppError("CONFLICT", { reason: "not_paused" });
  await tx.updateTable("attempts").set({ status: "in_progress" }).where("id", "=", attempt.id).execute();
}

/** Recompute the risk score; open or refresh a case while it is still only "flagged". */
async function updateRisk(tx: Tx, attempt: Pick<Attempt, "id" | "tenant_id">, rg: RoundGroupConfig) {
  const events = await tx.selectFrom("integrity_events").select("type").where("attempt_id", "=", attempt.id).execute();
  const risk = riskScore(events, { copyPaste: rg.integrity.copyPaste });
  await tx.updateTable("attempts").set({ risk_score: risk.score }).where("id", "=", attempt.id).execute();
  if (risk.score < RISK_FLAG_THRESHOLD) return risk;
  const existing = await tx.selectFrom("risk_cases").select(["id", "status"]).where("attempt_id", "=", attempt.id).executeTakeFirst();
  if (!existing) {
    await tx.insertInto("risk_cases").values({ tenant_id: attempt.tenant_id, attempt_id: attempt.id, risk_score: risk.score, signals: JSON.stringify(risk.signals) }).execute();
  } else if (existing.status === "flagged") {
    await tx.updateTable("risk_cases").set({ risk_score: risk.score, signals: JSON.stringify(risk.signals) }).where("id", "=", existing.id).execute();
  }
  return risk;
}

// ---------------------------------------------------------------- submit and score

/**
 * Close the attempt, grade every answer, score it with the round-group's
 * rule, run the server-side anomaly checks, and update the risk score.
 * The score is provisional: official results are produced, reviewed and
 * published in the judging stage.
 */
export async function submitAttempt(tx: Tx, request: FastifyRequest | null, attempt: Attempt, reason: "participant" | "time_up" | "integrity_policy" | "admin", now: Date): Promise<Attempt> {
  const locked = await tx.selectFrom("attempts").selectAll().where("id", "=", attempt.id).forUpdate().executeTakeFirstOrThrow();
  if (locked.status === "submitted" || locked.status === "invalidated") return locked as Attempt;
  const { rg } = await loadVersionContext(tx, locked.competition_version_id, locked.round_id, locked.group_id);
  const refs = locked.question_set as QuestionRef[];
  const pool = await loadPool(tx, locked.content_version_id, refs.map((r) => r.itemId));
  const answers = new Map((await tx.selectFrom("attempt_answers").selectAll().where("attempt_id", "=", locked.id).execute()).map((a) => [a.item_id, a]));

  const graded: GradedItem[] = [];
  const facts: AnswerFact[] = [];
  let pendingAi = false;
  let pendingManual = false;
  for (const ref of refs) {
    const item = pool.get(ref.itemId)!.snapshot.item;
    const answer = answers.get(ref.itemId);
    const grade: GradeOutcome = gradeResponse(item, (answer?.response ?? null) as ItemResponse | null);
    if (grade.outcome === "pending_ai") pendingAi = true;
    if (grade.outcome === "pending_manual") pendingManual = true;
    const g = toGradedItem({ itemId: ref.itemId, points: item.points, difficulty: item.difficulty }, grade, answer?.time_spent_ms);
    if (g) graded.push(g);
    if (answer) {
      await tx.updateTable("attempt_answers").set({ grade: JSON.stringify(grade) }).where("attempt_id", "=", locked.id).where("item_id", "=", ref.itemId).execute();
      const chosen = (answer.response as { optionId?: string } | null)?.optionId;
      facts.push({
        itemId: ref.itemId,
        response: JSON.stringify(answer.response),
        correct: grade.outcome === "correct",
        timeSpentMs: answer.time_spent_ms,
        displayedPosition: chosen && ref.order.options ? ref.order.options.indexOf(chosen) : null,
      });
    }
  }
  const score = scoreAttempt(graded, rg.scoring);
  const { items: _items, ...summary } = score;
  void _items;

  // Server-side anomaly checks.
  const speed = detectImpossibleSpeed(facts);
  if (speed) await serverEvent(tx, locked, null, "impossible_speed", speed);
  const pattern = detectAnswerPattern(facts);
  if (pattern) await serverEvent(tx, locked, null, "answer_pattern", pattern);
  const others = await tx
    .selectFrom("attempts")
    .select(["id"])
    .where("round_id", "=", locked.round_id)
    .where("group_id", "=", locked.group_id)
    .where("status", "=", "submitted")
    .where("student_id", "!=", locked.student_id)
    .orderBy("submitted_at", "desc")
    .limit(200)
    .execute();
  if (others.length && facts.length) {
    const theirAnswers = await tx.selectFrom("attempt_answers").select(["attempt_id", "item_id", "response", "grade"]).where("attempt_id", "in", others.map((o) => o.id)).execute();
    const byAttempt = new Map<string, AnswerFact[]>();
    for (const a of theirAnswers) {
      const list = byAttempt.get(a.attempt_id) ?? [];
      list.push({ itemId: a.item_id, response: JSON.stringify(a.response), correct: (a.grade as { outcome?: string } | null)?.outcome === "correct", timeSpentMs: 0, displayedPosition: null });
      byAttempt.set(a.attempt_id, list);
    }
    for (const [otherId, theirs] of byAttempt) {
      const sim = detectAnswerSimilarity(facts, theirs);
      if (sim) {
        await serverEvent(tx, locked, null, "answer_similarity", { otherAttemptId: otherId, ...sim });
        break;
      }
    }
  }

  await tx
    .updateTable("attempts")
    .set({
      status: "submitted",
      submitted_at: now,
      submit_reason: reason,
      score: JSON.stringify(summary),
      score_status: pendingAi ? "pending_ai" : pendingManual ? "pending_manual" : "scored",
    })
    .where("id", "=", locked.id)
    .execute();
  await tx.updateTable("attempt_sessions").set({ status: "closed" }).where("attempt_id", "=", locked.id).where("status", "=", "active").execute();
  const risk = await updateRisk(tx, locked, rg);
  await audit(tx, request, {
    tenantId: locked.tenant_id,
    actorUserId: reason === "participant" ? (request?.auth?.userId ?? null) : null,
    action: "attempt.submitted",
    targetType: "attempt",
    targetId: locked.id,
    after: { reason, totalScore: summary.totalScore, maxScore: summary.maxScore, riskScore: risk.score, pendingAi, pendingManual },
    metadata: reason === "participant" ? {} : { via: "system" },
  });
  return (await tx.selectFrom("attempts").selectAll().where("id", "=", locked.id).executeTakeFirstOrThrow()) as Attempt;
}

/** Submit on access if the deadline (plus offline-sync grace) has passed. */
export async function closeIfExpired(tx: Tx, request: FastifyRequest | null, attempt: Attempt, now: Date): Promise<Attempt> {
  if ((attempt.status === "in_progress" || attempt.status === "paused") && isPastDeadline(attempt.deadline_at, now)) {
    return submitAttempt(tx, request, attempt, "time_up", now);
  }
  return attempt;
}
