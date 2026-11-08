import { beforeAll, describe, expect, it } from "vitest";
import type { CompetitionConfig } from "@cos/core";
import { runMaintenance } from "../src/lib/maintenance.ts";
import { PASSWORD, call, createPlatformAdmin, createTenant, login, register, unique, type Session, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let platform: Session;
let A: TenantFixture;
let contentVersionId: string;

beforeAll(async () => {
  platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "Runtime");
  const c = `/t/${A.tenantId}/content`;
  const bank = (await call(env.app, A.admin, "POST", `${c}/banks`, { key: unique("rt"), name: "Runtime bank", baseLocale: "en" })).body.bank.id;
  for (let i = 0; i < 12; i++) {
    const r = await call(env.app, A.admin, "POST", `${c}/banks/${bank}/items`, {
      externalKey: `RT-${String(i).padStart(2, "0")}`, contentType: "single_choice", baseLocale: "en", difficulty: i < 6 ? "easy" : "hard", status: "ready",
      body: { prompt: `Question ${i}`, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }], correctOptionId: "b" },
    });
    expect(r.status).toBe(201);
  }
  contentVersionId = (await call(env.app, A.admin, "POST", `${c}/banks/${bank}/versions`, {})).body.version.id;
});

interface Setup {
  competitionId: string;
  roundId: string;
  registrationId: string;
  parent: Session;
  childId: string;
}

/** A published competition whose qualifying round is open now, with one registered child. */
async function setup(opts: { integrity?: Record<string, unknown>; durationSeconds?: number; showScore?: boolean; maxAttempts?: number | null; opensInFuture?: boolean } = {}): Promise<Setup> {
  const base = `/t/${A.tenantId}/competitions`;
  const created = await call(env.app, A.admin, "POST", base, { slug: unique("rt"), name: "Live Cup", feeMode: "free", contentLocales: ["en"] });
  const { competition, draft } = created.body;
  const config: CompetitionConfig = draft.config;
  const round = config.rounds[0]!;
  round.opensAt = new Date(Date.now() + (opts.opensInFuture ? 3_600_000 : -60_000)).toISOString();
  round.closesAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  config.rounds[1]!.opensAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  config.rounds[1]!.closesAt = new Date(Date.now() + 4 * 3_600_000).toISOString();
  if (opts.maxAttempts !== undefined) round.attemptPolicy.maxAttempts = opts.maxAttempts;
  const primary = config.groups.find((g) => g.key === "primary")!.id;
  const rg = round.groups.find((g) => g.groupId === primary)!;
  rg.content.contentBankVersionId = contentVersionId;
  rg.questionCount = 10;
  rg.durationSeconds = opts.durationSeconds ?? 600;
  rg.ui.showScoreOnSubmit = opts.showScore ?? false;
  Object.assign(rg.integrity, opts.integrity ?? {});
  for (const g of round.groups) if (g.groupId !== primary) g.enabled = false;
  for (const g of config.rounds[1]!.groups) g.enabled = g.groupId === primary;
  const saved = await call(env.app, A.admin, "PUT", `${base}/${competition.id}/versions/${draft.id}/config`, { revision: 1, config });
  expect(saved.body.version.issues.filter((i: { severity: string }) => i.severity === "error"), JSON.stringify(saved.body.version.issues)).toEqual([]);
  expect((await call(env.app, A.admin, "POST", `${base}/${competition.id}/versions/${draft.id}/publish`, {})).status).toBe(200);

  const parent = await register(env.app, "parent");
  const childId = (await call(env.app, parent, "POST", "/me/children", { givenName: unique("kid"), dateOfBirth: "2016-04-01" })).body.child.id;
  const reg = await call(env.app, parent, "POST", "/me/registrations", { competitionId: competition.id, studentId: childId, groupId: primary, grade: "P4", contentLocale: "en", consent: { accepted: true, version: "v1" } });
  expect(reg.body.registration.status).toBe("confirmed");
  return { competitionId: competition.id, roundId: round.id, registrationId: reg.body.registration.id, parent, childId };
}

const device = (n = 1) => ({ deviceId: `device-${n}-${"x".repeat(8)}` });
const start = (s: Setup, who: Session = s.parent, d = device()) => call(env.app, who, "POST", "/me/attempts", { registrationId: s.registrationId, roundId: s.roundId, ...d });
const save = (who: Session, attemptId: string, sessionId: string, answers: Array<Record<string, unknown>>) => call(env.app, who, "PUT", `/me/attempts/${attemptId}/answers`, { sessionId, answers });
const answer = (itemId: string, optionId: string, clientSeq = 1, extra: Record<string, unknown> = {}) => ({ itemId, response: { optionId }, clientSeq, timeSpentMs: 20_000, ...extra });

describe("starting and resuming", () => {
  it("starts with server time, hides answers, and resumes the same attempt on refresh", async () => {
    const s = await setup();
    const res = await start(s);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.attempt).toMatchObject({ status: "in_progress", kind: "official", attemptNumber: 1 });
    expect(res.body.attempt.remainingSeconds).toBeGreaterThan(590);
    expect(res.body.questions).toHaveLength(10);
    expect(JSON.stringify(res.body.questions)).not.toContain("correctOptionId");
    expect(res.body.policy).toMatchObject({ fullscreen: "warn", copyPaste: "flag", maxDevices: 1 });

    const again = await start(s);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ resumed: true, sessionId: res.body.sessionId, attempt: { id: res.body.attempt.id } });
    expect(again.body.questions.map((q: { itemId: string }) => q.itemId)).toEqual(res.body.questions.map((q: { itemId: string }) => q.itemId));
    const listed = await call(env.app, s.parent, "GET", `/me/rounds?studentId=${s.childId}`);
    expect(listed.body.rounds.find((r: { round: { id: string } }) => r.round.id === s.roundId)).toMatchObject({ state: "open", attemptsUsed: 1, attemptsLeft: 0, runningAttemptId: res.body.attempt.id });
  });

  it("refuses rounds that are not open, unconfirmed registrations and qualified-entry rounds", async () => {
    const s = await setup({ opensInFuture: true });
    expect((await start(s)).body.error.details.reason).toBe("round_not_open");
    const listed = await call(env.app, s.parent, "GET", "/me/rounds");
    const finals = listed.body.rounds.filter((r: { registrationId: string; entry: string }) => r.registrationId === s.registrationId && r.entry === "qualified_from");
    expect(finals).toHaveLength(1);
    const final = await call(env.app, s.parent, "POST", "/me/attempts", { registrationId: s.registrationId, roundId: finals[0].round.id, ...device() });
    expect(final.body.error.details.reason).toBe("qualification_not_available");
  });

  it("only the student or their parent can run the attempt", async () => {
    const s = await setup();
    const stranger = await register(env.app, "stranger");
    expect((await start(s, stranger)).status).toBe(404);
    const res = await start(s);
    expect((await call(env.app, stranger, "GET", `/me/attempts/${res.body.attempt.id}`)).status).toBe(404);
    const other = await createTenant(env, platform, "OtherRT");
    expect((await call(env.app, other.admin, "GET", `/t/${other.tenantId}/attempts/${res.body.attempt.id}`)).status).toBe(404);

    // The child's own login works too.
    const username = unique("kid").toLowerCase().replace(/[^a-z0-9]/g, "");
    await call(env.app, s.parent, "POST", `/me/children/${s.childId}/login`, { username, password: PASSWORD });
    const kid = await login(env.app, username);
    expect((await call(env.app, kid, "GET", `/me/attempts/${res.body.attempt.id}`)).status).toBe(200);
  });
});

describe("autosave, submit and scoring", () => {
  it("saves batches, ignores stale syncs, restores answers on resume, and scores on submit", async () => {
    const s = await setup({ showScore: true });
    const res = await start(s);
    const { sessionId } = res.body;
    const ids: string[] = res.body.questions.map((q: { itemId: string }) => q.itemId);

    const first = await save(s.parent, res.body.attempt.id, sessionId, [answer(ids[0]!, "b", 2), answer(ids[1]!, "a", 1), { ...answer("00000000-0000-4000-8000-000000000000", "b") }]);
    expect(first.body.saved).toEqual([ids[0], ids[1]]);
    expect(first.body.rejected).toEqual([{ itemId: "00000000-0000-4000-8000-000000000000", reason: "not_in_attempt" }]);
    const stale = await save(s.parent, res.body.attempt.id, sessionId, [answer(ids[0]!, "c", 1)]);
    expect(stale.body.rejected).toEqual([{ itemId: ids[0], reason: "stale" }]);
    await save(s.parent, res.body.attempt.id, sessionId, [answer(ids[1]!, "b", 2), ...ids.slice(2, 5).map((id) => answer(id, "b"))]);

    const resumed = await call(env.app, s.parent, "GET", `/me/attempts/${res.body.attempt.id}?sessionId=${sessionId}`);
    expect(resumed.body.answers).toHaveLength(5);
    expect(resumed.body.answers.find((a: { itemId: string }) => a.itemId === ids[0]).response).toEqual({ optionId: "b" });

    const done = await call(env.app, s.parent, "POST", `/me/attempts/${res.body.attempt.id}/submit`, { sessionId });
    expect(done.body.attempt).toMatchObject({ status: "submitted", submitReason: "participant" });
    expect(done.body.result).toMatchObject({ totalScore: 5, maxScore: 10, provisional: true });
    expect((await save(s.parent, res.body.attempt.id, sessionId, [answer(ids[6]!, "b")])).body.error.details.reason).toBe("attempt_closed");
    expect((await start(s)).body.error.details.reason).toBe("no_attempts_left");

    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`);
    expect(detail.body.attempt).toMatchObject({ score: { totalScore: 5, correctCount: 5, unansweredCount: 5 }, scoreStatus: "scored" });
    expect(detail.body.questions[0]).toMatchObject({ position: 1, grade: { outcome: "correct" } });
  });

  it("hides the score unless the round shows it", async () => {
    const s = await setup();
    const res = await start(s);
    const done = await call(env.app, s.parent, "POST", `/me/attempts/${res.body.attempt.id}/submit`, { sessionId: res.body.sessionId });
    expect(done.body.result).toBeNull();
  });
});

describe("server-authoritative time", () => {
  it("applies network grace, accepts offline answers saved before the deadline, and auto-submits", async () => {
    const s = await setup();
    const res = await start(s);
    const { sessionId } = res.body;
    const id = res.body.attempt.id;
    const ids: string[] = res.body.questions.map((q: { itemId: string }) => q.itemId);
    const setDeadline = (secondsAgo: number) => env.owner.query(`update attempts set deadline_at = now() - make_interval(secs => $2), started_at = now() - interval '20 minutes' where id = $1`, [id, secondsAgo]);

    await setDeadline(5);
    expect((await save(s.parent, id, sessionId, [answer(ids[0]!, "b")])).body.saved).toEqual([ids[0]]);

    await setDeadline(60);
    const offline = await save(s.parent, id, sessionId, [
      answer(ids[1]!, "b", 1, { clientSavedAt: new Date(Date.now() - 90_000).toISOString() }),
      answer(ids[2]!, "b", 1),
    ]);
    expect(offline.body.saved).toEqual([ids[1]]);
    expect(offline.body.rejected).toEqual([{ itemId: ids[2], reason: "after_deadline" }]);

    await setDeadline(200);
    const state = await call(env.app, s.parent, "GET", `/me/attempts/${id}`);
    expect(state.body.attempt).toMatchObject({ status: "submitted", submitReason: "time_up" });
    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${id}`);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toContain("late_sync");
    expect(detail.body.attempt.score.totalScore).toBe(2);
  });

  it("the worker submits attempts abandoned past their deadline", async () => {
    const s = await setup();
    const res = await start(s);
    await env.owner.query("update attempts set deadline_at = now() - interval '10 minutes', started_at = now() - interval '30 minutes' where id = $1", [res.body.attempt.id]);
    const report = await runMaintenance(env.db);
    expect(report.attemptsSubmitted).toBeGreaterThanOrEqual(1);
    const { rows } = await env.owner.query("select status, submit_reason from attempts where id = $1", [res.body.attempt.id]);
    expect(rows[0]).toEqual({ status: "submitted", submit_reason: "time_up" });
  });
});

describe("devices and sessions", () => {
  it("refuses a second device when only one is allowed, and records it", async () => {
    const s = await setup();
    const res = await start(s, s.parent, device(1));
    const second = await start(s, s.parent, device(2));
    expect(second.status).toBe(409);
    expect(second.body.error.details).toEqual({ reason: "device_limit", allowed: 1 });
    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toContain("device_limit_exceeded");
    expect(detail.body.attempt.status).toBe("in_progress");
  });

  it("with two devices allowed, the newer session takes over and concurrency is recorded", async () => {
    const s = await setup({ integrity: { maxDevices: 2 } });
    const one = await start(s, s.parent, device(1));
    const two = await start(s, s.parent, device(2));
    expect(two.status).toBe(200);
    expect(two.body.sessionId).not.toBe(one.body.sessionId);
    const ids: string[] = one.body.questions.map((q: { itemId: string }) => q.itemId);
    expect((await save(s.parent, one.body.attempt.id, one.body.sessionId, [answer(ids[0]!, "b")])).body.error.details.reason).toBe("session_superseded");
    expect((await save(s.parent, one.body.attempt.id, two.body.sessionId, [answer(ids[0]!, "b")])).body.saved).toEqual([ids[0]]);
    expect((await start(s, s.parent, device(3))).body.error.details.reason).toBe("device_limit");
    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${one.body.attempt.id}`);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["concurrent_session", "device_limit_exceeded"]));
  });

  it("records long connection gaps", async () => {
    const s = await setup();
    const res = await start(s);
    await env.owner.query("update attempt_sessions set last_seen_at = now() - interval '3 minutes' where id = $1", [res.body.sessionId]);
    expect((await call(env.app, s.parent, "POST", `/me/attempts/${res.body.attempt.id}/heartbeat`, { sessionId: res.body.sessionId })).body.status).toBe("in_progress");
    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`);
    const gap = detail.body.events.find((e: { type: string }) => e.type === "connection_gap");
    expect(gap.details.seconds).toBeGreaterThanOrEqual(179);
  });
});

describe("integrity signals and policies", () => {
  const events = (s: Setup, attemptId: string, sessionId: string, types: string[]) =>
    call(env.app, s.parent, "POST", `/me/attempts/${attemptId}/events`, { sessionId, events: types.map((type) => ({ type, at: new Date().toISOString() })) });

  it("raises a risk score from browser signals and opens a flagged case (never a penalty)", async () => {
    const s = await setup();
    const res = await start(s);
    expect((await events(s, res.body.attempt.id, res.body.sessionId, [...Array(10).fill("tab_hidden"), "paste", "paste"])).body).toEqual({ action: "none", status: "in_progress" });
    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`);
    expect(detail.body.attempt.riskScore).toBe(31);
    expect(detail.body.riskCase).toMatchObject({ status: "flagged", riskScore: 31 });
    expect(detail.body.attempt.status).toBe("in_progress");
    const flagged = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/competitions/${s.competitionId}/attempts?minRisk=30`);
    expect(flagged.body.attempts.map((a: { id: string }) => a.id)).toEqual([res.body.attempt.id]);
  });

  it("fullscreen policy: warn, pause (questions hidden, timer running) and auto-submit", async () => {
    const warn = await setup();
    const w = await start(warn);
    expect((await events(warn, w.body.attempt.id, w.body.sessionId, ["fullscreen_exit"])).body.action).toBe("warn");

    const pause = await setup({ integrity: { fullscreen: "pause" } });
    const p = await start(pause);
    expect((await events(pause, p.body.attempt.id, p.body.sessionId, ["fullscreen_exit"])).body).toEqual({ action: "pause", status: "paused" });
    const paused = await call(env.app, pause.parent, "GET", `/me/attempts/${p.body.attempt.id}`);
    expect(paused.body.questions).toEqual([]);
    expect(paused.body.attempt.remainingSeconds).toBeGreaterThan(0);
    const ids: string[] = p.body.questions.map((q: { itemId: string }) => q.itemId);
    expect((await save(pause.parent, p.body.attempt.id, p.body.sessionId, [answer(ids[0]!, "b")])).body.error.details.reason).toBe("attempt_paused");
    const resumed = await call(env.app, pause.parent, "POST", `/me/attempts/${p.body.attempt.id}/resume`, { sessionId: p.body.sessionId });
    expect(resumed.body.questions).toHaveLength(10);

    const auto = await setup({ integrity: { fullscreen: "auto_submit" } });
    const a = await start(auto);
    expect((await events(auto, a.body.attempt.id, a.body.sessionId, ["fullscreen_exit"])).body).toEqual({ action: "submitted", status: "submitted" });
    const { rows } = await env.owner.query("select status, submit_reason from attempts where id = $1", [a.body.attempt.id]);
    expect(rows[0]).toEqual({ status: "submitted", submit_reason: "integrity_policy" });
  });

  it("copy/paste is ignored for risk when the round allows it", async () => {
    const s = await setup({ integrity: { copyPaste: "allow" } });
    const res = await start(s);
    await events(s, res.body.attempt.id, res.body.sessionId, Array(10).fill("paste"));
    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`);
    expect(detail.body.attempt.riskScore).toBe(0);
  });

  it("detects impossible speed and shared wrong answers between students", async () => {
    const s1 = await setup({ maxAttempts: 1 });
    // Second student in the same round and group.
    const parent2 = await register(env.app, "parent2");
    const child2 = (await call(env.app, parent2, "POST", "/me/children", { givenName: unique("kid"), dateOfBirth: "2016-05-05" })).body.child.id;
    const comp = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/competitions/${s1.competitionId}/registrations`);
    const groupId = comp.body.registrations[0].groupId;
    const reg2 = await call(env.app, parent2, "POST", "/me/registrations", { competitionId: s1.competitionId, studentId: child2, groupId, grade: "P4", contentLocale: "en", consent: { accepted: true, version: "v1" } });
    const s2: Setup = { ...s1, registrationId: reg2.body.registration.id, parent: parent2, childId: child2 };

    // Same answers per question (not per screen position, which is shuffled per student).
    const wrongAnswers = (q: Array<{ itemId: string }>) => {
      const sorted = q.map((x) => x.itemId).sort();
      return sorted.map((itemId, i) => answer(itemId, i < 4 ? "b" : "d", 1, { timeSpentMs: i < 4 ? 500 : 20_000 }));
    };
    const a1 = await start(s1, s1.parent, device(1));
    await save(s1.parent, a1.body.attempt.id, a1.body.sessionId, wrongAnswers(a1.body.questions));
    await call(env.app, s1.parent, "POST", `/me/attempts/${a1.body.attempt.id}/submit`, { sessionId: a1.body.sessionId });
    const a2 = await start(s2, parent2, device(2));
    await save(parent2, a2.body.attempt.id, a2.body.sessionId, wrongAnswers(a2.body.questions));
    await call(env.app, parent2, "POST", `/me/attempts/${a2.body.attempt.id}/submit`, { sessionId: a2.body.sessionId });

    const detail = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${a2.body.attempt.id}`);
    const types = detail.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(["impossible_speed", "answer_similarity"]));
    expect(detail.body.riskCase.status).toBe("flagged");
    expect(detail.body.attempt.status).toBe("submitted");
  });
});

describe("review access", () => {
  it("judges can review attempts; school admins cannot", async () => {
    const s = await setup();
    const res = await start(s);
    const judge = await register(env.app, "judge");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: judge.email, role: "judge" });
    expect((await call(env.app, judge, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`)).status).toBe(200);
    const school = (await call(env.app, A.admin, "POST", `/t/${A.tenantId}/schools`, { name: "S" })).body.school.id;
    const sa = await register(env.app, "sa");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: sa.email, role: "school_admin", schoolId: school });
    expect((await call(env.app, sa, "GET", `/t/${A.tenantId}/attempts/${res.body.attempt.id}`)).status).toBe(403);
  });
});
