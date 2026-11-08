import { beforeAll, describe, expect, it } from "vitest";
import type { CompetitionConfig } from "@cos/core";
import { call, createPlatformAdmin, createTenant, register, unique, type Session, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let A: TenantFixture;
let platform: Session;
let headJudge: Session;
let judge: Session;
let mainVersion: string;
let manualVersion: string;
const items: Record<string, string> = {}; // externalKey → item id

beforeAll(async () => {
  platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "Results");
  headJudge = await register(env.app, "head-judge");
  judge = await register(env.app, "judge");
  await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: headJudge.email, role: "head_judge" });
  await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: judge.email, role: "judge" });

  const c = `/t/${A.tenantId}/content`;
  const mk = async (bank: string, key: string, body?: unknown, contentType = "single_choice") => {
    const r = await call(env.app, A.admin, "POST", `${c}/banks/${bank}/items`, {
      externalKey: key, contentType, baseLocale: "en", difficulty: "medium", status: "ready",
      body: body ?? { prompt: `Q ${key}`, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }], correctOptionId: "b" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    items[key] = r.body.item.id;
  };
  const bank = (await call(env.app, A.admin, "POST", `${c}/banks`, { key: unique("res"), name: "Main", baseLocale: "en" })).body.bank.id;
  for (let i = 0; i < 12; i++) await mk(bank, `J-${String(i).padStart(2, "0")}`);
  mainVersion = (await call(env.app, A.admin, "POST", `${c}/banks/${bank}/versions`, {})).body.version.id;
  const bank2 = (await call(env.app, A.admin, "POST", `${c}/banks`, { key: unique("man"), name: "Manual", baseLocale: "en" })).body.bank.id;
  for (let i = 0; i < 4; i++) await mk(bank2, `M-${i}`);
  await mk(bank2, "M-CUSTOM", { prompt: "Draw the character 永", customType: "stroke-order", data: {} }, "custom");
  manualVersion = (await call(env.app, A.admin, "POST", `${c}/banks/${bank2}/versions`, {})).body.version.id;
});

interface Comp {
  id: string;
  versionId: string;
  qualifying: string;
  final: string;
  group: string;
}

async function competition(opts: { content?: string; questionCount?: number; formats?: string[] } = {}): Promise<Comp> {
  const base = `/t/${A.tenantId}/competitions`;
  const created = await call(env.app, A.admin, "POST", base, { slug: unique("res"), name: "Results Cup", feeMode: "free", contentLocales: ["en"] });
  const { competition, draft } = created.body;
  const config: CompetitionConfig = draft.config;
  const [q, f] = config.rounds as [CompetitionConfig["rounds"][number], CompetitionConfig["rounds"][number]];
  q.opensAt = new Date(Date.now() - 60_000).toISOString();
  q.closesAt = new Date(Date.now() + 3_600_000).toISOString();
  f.opensAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  f.closesAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const group = config.groups.find((g) => g.key === "primary")!.id;
  for (const round of [q, f]) {
    for (const g of round.groups) g.enabled = g.groupId === group;
    const rg = round.groups.find((g) => g.groupId === group)!;
    rg.content.contentBankVersionId = opts.content ?? mainVersion;
    rg.questionCount = opts.questionCount ?? 10;
    rg.randomizeQuestions = false;
    if (opts.formats) rg.questionFormats = opts.formats as never;
  }
  q.groups.find((g) => g.groupId === group)!.qualification = { combine: "any", criteria: [{ type: "top_n", n: 2 }], ties: "include", quota: null, maxWildcards: 1 };
  await call(env.app, A.admin, "PUT", `${base}/${competition.id}/versions/${draft.id}/config`, { revision: 1, config });
  const pub = await call(env.app, A.admin, "POST", `${base}/${competition.id}/versions/${draft.id}/publish`, {});
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  await call(env.app, A.admin, "PATCH", `${base}/${competition.id}/results-settings`, { leaderboardPrivacy: "first_name_initial" });
  return { id: competition.id, versionId: draft.id, qualifying: q.id, final: f.id, group };
}

/** Simulate time passing: move a round's window in the published config (bypassing the publish lock, as only a test may). */
async function moveRound(c: Comp, index: number, opensAgoMs: number, closesAgoMs: number) {
  await env.owner.query("alter table competition_versions disable trigger competition_versions_guard");
  await env.owner.query(
    `update competition_versions set config = jsonb_set(jsonb_set(config, $2, to_jsonb($3::text)), $4, to_jsonb($5::text)) where id = $1`,
    [c.versionId, `{rounds,${index},opensAt}`, new Date(Date.now() - opensAgoMs).toISOString(), `{rounds,${index},closesAt}`, new Date(Date.now() - closesAgoMs).toISOString()],
  );
  await env.owner.query("alter table competition_versions enable trigger competition_versions_guard");
}

interface Participant {
  parent: Session;
  childId: string;
  registrationId: string;
  attemptId: string;
  sessionId: string;
}

/** Register a child, take the qualifying round, answer `correct` questions right, and submit. */
async function participant(c: Comp, name: string, correct: number, opts: { submit?: boolean } = {}): Promise<Participant> {
  const parent = await register(env.app, `p-${name}`);
  const childId = (await call(env.app, parent, "POST", "/me/children", { givenName: name, familyName: "Lee", dateOfBirth: "2016-04-01" })).body.child.id;
  const reg = await call(env.app, parent, "POST", "/me/registrations", { competitionId: c.id, studentId: childId, groupId: c.group, grade: "P4", contentLocale: "en", consent: { accepted: true, version: "v1" } });
  const start = await call(env.app, parent, "POST", "/me/attempts", { registrationId: reg.body.registration.id, roundId: c.qualifying, deviceId: `device-${name}-xxxxxxxx` });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const qs: Array<{ itemId: string; contentType: string }> = start.body.questions;
  const answers = qs.map((q, i) => (q.contentType === "custom" ? { itemId: q.itemId, response: { custom: { strokes: 5 } }, clientSeq: 1 } : { itemId: q.itemId, response: { optionId: i < correct ? "b" : "a" }, clientSeq: 1, timeSpentMs: 15_000 }));
  await call(env.app, parent, "PUT", `/me/attempts/${start.body.attempt.id}/answers`, { sessionId: start.body.sessionId, answers });
  if (opts.submit !== false) await call(env.app, parent, "POST", `/me/attempts/${start.body.attempt.id}/submit`, { sessionId: start.body.sessionId });
  return { parent, childId, registrationId: reg.body.registration.id, attemptId: start.body.attempt.id, sessionId: start.body.sessionId };
}

const results = (c: Comp) => `/t/${A.tenantId}/competitions/${c.id}/results`;
const compute = (c: Comp, who: Session = A.admin, extra: Record<string, unknown> = {}) => call(env.app, who, "POST", results(c), { roundId: c.qualifying, groupId: c.group, ...extra });
const v = (id: string, action = "") => `/t/${A.tenantId}/results/${id}${action}`;

async function publish(c: Comp, versionId: string) {
  await call(env.app, A.admin, "POST", v(versionId, "/submit"));
  await call(env.app, judge, "POST", v(versionId, "/reviews"), { recommendation: "approve" });
  const res = await call(env.app, headJudge, "POST", v(versionId, "/approve"), { note: "Checked" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

describe("official results workflow", () => {
  it("draft → judge review → Head Judge approval → published, with every gate enforced", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 9);
    await participant(c, "Ben", 7);
    const cat = await participant(c, "Cat", 5);
    await participant(c, "Dan", 3);

    const draft = await compute(c);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.version).toMatchObject({ versionNumber: 1, status: "draft", summary: { participants: 4, ranked: 4, qualified: 2 } });
    const id = draft.body.version.id;
    const detail = await call(env.app, judge, "GET", v(id));
    expect(detail.body.entries.map((e: { totalScore: number; rank: number; qualified: boolean }) => [e.totalScore, e.rank, e.qualified])).toEqual([[9, 1, true], [7, 2, true], [5, 3, false], [3, 4, false]]);
    // Judges review blind; the organizer sees names.
    expect(detail.body.entries[0].student).toMatchObject({ studentCode: null, name: expect.stringMatching(/^P-/) });
    expect((await call(env.app, A.admin, "GET", v(id))).body.entries[0].student.name).toBe("Ann Lee");

    expect((await call(env.app, headJudge, "POST", v(id, "/approve"))).body.error.details.reason).toBe("not_in_review");
    expect((await call(env.app, A.admin, "POST", v(id, "/submit"))).body.version.status).toBe("in_review");
    expect((await call(env.app, headJudge, "POST", v(id, "/approve"))).body.error.details.reason).toBe("needs_judge_review");
    expect((await call(env.app, judge, "POST", v(id, "/reviews"), { recommendation: "approve", note: "Spot-checked 4 attempts" })).status).toBe(201);
    expect((await call(env.app, headJudge, "POST", v(id, "/approve"))).body.error.details.reason).toBe("round_still_open");
    await moveRound(c, 0, 3_600_000, 60_000);

    // Only the Head Judge approves — not the organizer, a judge, or the Platform Admin.
    for (const who of [A.admin, judge, platform]) expect((await call(env.app, who, "POST", v(id, "/approve"))).status).toBe(403);
    const ok = await call(env.app, headJudge, "POST", v(id, "/approve"), { note: "Approved" });
    expect(ok.body.version).toMatchObject({ status: "published", approvedBy: headJudge.userId });

    const board = await call(env.app, null, "GET", `/competitions/${c.id}/leaderboard?roundId=${c.qualifying}&groupId=${c.group}`);
    expect(board.body).toMatchObject({ official: true, versionNumber: 1 });
    expect(board.body.entries.map((e: { rank: number; name: string; qualified: boolean }) => `${e.rank}:${e.name}:${e.qualified}`)).toEqual(["1:Ann L.:true", "2:Ben L.:true", "3:Cat L.:false", "4:Dan L.:false"]);
    expect(JSON.stringify(board.body)).not.toMatch(/S[0-9A-HJKMNP-TV-Z]{9}/);

    const mine = await call(env.app, ann.parent, "GET", "/me/results");
    expect(mine.body.results).toEqual([expect.objectContaining({ roundId: c.qualifying, rank: 1, qualified: true, totalScore: 9 })]);
    expect((await call(env.app, cat.parent, "GET", "/me/results")).body.results[0]).toMatchObject({ rank: 3, qualified: false });
  });

  it("only qualified participants can enter the final, once results are published", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 9);
    await participant(c, "Ben", 7);
    const cat = await participant(c, "Cat", 2);
    await moveRound(c, 0, 3_600_000, 60_000);
    await moveRound(c, 1, 60_000, -3_600_000);
    const startFinal = (p: Participant) => call(env.app, p.parent, "POST", "/me/attempts", { registrationId: p.registrationId, roundId: c.final, deviceId: "device-final-xxxxxxxx" });
    expect((await startFinal(ann)).body.error.details.reason).toBe("qualification_not_available");
    await publish(c, (await compute(c)).body.version.id);
    expect((await startFinal(ann)).status).toBe(201);
    expect((await startFinal(cat)).body.error.details.reason).toBe("not_qualified");
  });

  it("Head Judge overrides create a new version; the old one is kept as superseded, with the diff", async () => {
    const c = await competition();
    await participant(c, "Ann", 9);
    const ben = await participant(c, "Ben", 7);
    const cat = await participant(c, "Cat", 5);
    await moveRound(c, 0, 3_600_000, 60_000);
    const v1 = (await compute(c)).body.version.id;
    await publish(c, v1);

    const overrides = [{ registrationId: cat.registrationId, type: "score", totalScore: 8, reason: "Answer key error on Q3 (appeal upheld)" }];
    expect((await compute(c, judge, { overrides })).status).toBe(403);
    expect((await compute(c, A.admin, { overrides })).status).toBe(403);
    const v2 = await compute(c, headJudge, { overrides, note: "Appeal #12" });
    expect(v2.status).toBe(201);
    expect(v2.body.version.changes).toEqual(
      expect.arrayContaining([
        { registrationId: cat.registrationId, before: { totalScore: 5, rank: 3, qualified: false, status: "ok" }, after: { totalScore: 8, rank: 2, qualified: true, status: "ok" } },
        { registrationId: ben.registrationId, before: { totalScore: 7, rank: 2, qualified: true, status: "ok" }, after: { totalScore: 7, rank: 3, qualified: false, status: "ok" } },
      ]),
    );
    await publish(c, v2.body.version.id);
    const versions = await call(env.app, A.admin, "GET", `${results(c)}?roundId=${c.qualifying}`);
    expect(versions.body.versions.map((x: { versionNumber: number; status: string }) => `${x.versionNumber}:${x.status}`)).toEqual(["2:published", "1:superseded"]);
    const entries = (await call(env.app, judge, "GET", v(v2.body.version.id))).body.entries;
    expect(entries.find((e: { registrationId: string }) => e.registrationId === cat.registrationId)).toMatchObject({ totalScore: 8, originalScore: 5 });

    // Overrides carry into later recomputations until replaced.
    const v3 = await compute(c);
    expect(v3.body.version.overrides).toHaveLength(1);
  });

  it("changes requested sends the version back to draft", async () => {
    const c = await competition();
    await participant(c, "Ann", 5);
    const id = (await compute(c)).body.version.id;
    await call(env.app, A.admin, "POST", v(id, "/submit"));
    expect((await call(env.app, judge, "POST", v(id, "/reviews"), { recommendation: "changes_requested" })).status).toBe(400);
    await call(env.app, judge, "POST", v(id, "/reviews"), { recommendation: "changes_requested", note: "Ann's attempt needs a look" });
    expect((await call(env.app, judge, "GET", v(id))).body.version.status).toBe("draft");
  });
});

describe("emergency actions (Head Judge only)", () => {
  it("full credit for a faulty question re-scores attempts, keeps score history, and recalculates results", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 9);
    const ben = await participant(c, "Ben", 4);
    const v1 = (await compute(c)).body.version.id;
    const emergency = `/t/${A.tenantId}/competitions/${c.id}/emergency`;
    const body = { roundId: c.qualifying, itemId: items["J-09"], action: "full_credit", reason: "Two correct options in Q10" };
    expect((await call(env.app, A.admin, "POST", `${emergency}/questions`, body)).status).toBe(403);
    expect((await call(env.app, judge, "POST", `${emergency}/questions`, body)).status).toBe(403);
    const res = await call(env.app, headJudge, "POST", `${emergency}/questions`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.rescored).toEqual(expect.arrayContaining([{ attemptId: ann.attemptId, before: 9, after: 10 }, { attemptId: ben.attemptId, before: 4, after: 5 }]));
    expect(res.body.recalculatedVersions).toHaveLength(1);
    expect((await call(env.app, headJudge, "POST", `${emergency}/questions`, body)).body.error.details.reason).toBe("question_already_adjusted");

    const versions = (await call(env.app, A.admin, "GET", `${results(c)}?roundId=${c.qualifying}`)).body.versions;
    expect(versions.map((x: { versionNumber: number; status: string; trigger: string }) => `${x.versionNumber}:${x.status}:${x.trigger}`)).toEqual(["2:draft:recalculation", "1:discarded:manual"]);
    expect(v1).toBe(versions[1].id);
    const { rows } = await env.owner.query("select score->>'totalScore' as s from attempt_score_history where attempt_id = $1", [ann.attemptId]);
    expect(rows).toEqual([{ s: "9" }]);
    expect((await call(env.app, A.admin, "GET", emergency)).status).toBe(403);
    const actions = await call(env.app, headJudge, "GET", emergency);
    expect(actions.body.actions[0]).toMatchObject({ kind: "full_credit", reason: "Two correct options in Q10", affected: { attemptIds: expect.arrayContaining([ann.attemptId, ben.attemptId]) } });
  });

  it("disable and replace: removed from scoring, and new attempts get the replacement", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 10);
    const emergency = `/t/${A.tenantId}/competitions/${c.id}/emergency`;
    const disabled = await call(env.app, headJudge, "POST", `${emergency}/questions`, { roundId: c.qualifying, itemId: items["J-01"], action: "disable", reason: "Typo in options" });
    expect(disabled.body.rescored).toEqual([{ attemptId: ann.attemptId, before: 10, after: 9 }]);
    await call(env.app, headJudge, "POST", `${emergency}/questions`, { roundId: c.qualifying, itemId: items["J-00"], action: "replace", replacementItemId: items["J-11"], reason: "Image missing" });
    const ben = await participant(c, "Ben", 0, { submit: false });
    const state = await call(env.app, ben.parent, "GET", `/me/attempts/${ben.attemptId}`);
    const ids = state.body.questions.map((q: { itemId: string }) => q.itemId);
    expect(ids).toContain(items["J-11"]);
    expect(ids).not.toContain(items["J-00"]);
    expect(ids).not.toContain(items["J-01"]);
  });

  it("extends time for running attempts, with before/after", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 0, { submit: false });
    const before = (await call(env.app, ann.parent, "GET", `/me/attempts/${ann.attemptId}`)).body.attempt.deadlineAt;
    const res = await call(env.app, headJudge, "POST", `/t/${A.tenantId}/competitions/${c.id}/emergency/extend-time`, { roundId: c.qualifying, seconds: 300, reason: "Network outage 10:05–10:10" });
    expect(res.body.affected).toBe(1);
    const after = (await call(env.app, ann.parent, "GET", `/me/attempts/${ann.attemptId}`)).body.attempt.deadlineAt;
    expect(Date.parse(after) - Date.parse(before)).toBe(300_000);
  });

  it("make-up attempt: original invalidated and kept; a new attempt is allowed even after the round closed", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 3);
    await moveRound(c, 0, 3_600_000, 60_000);
    const retry = () => call(env.app, ann.parent, "POST", "/me/attempts", { registrationId: ann.registrationId, roundId: c.qualifying, deviceId: "device-Ann-xxxxxxxx" });
    expect((await retry()).body.error.details.reason).toBe("no_attempts_left");
    const res = await call(env.app, headJudge, "POST", `/t/${A.tenantId}/competitions/${c.id}/emergency/makeup-attempt`, { attemptId: ann.attemptId, availableHours: 24, reason: "Power cut at the school" });
    expect(res.status).toBe(201);
    const second = await retry();
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.attempt.attemptNumber).toBe(2);
    const { rows } = await env.owner.query("select status, makeup_of from attempts where registration_id = $1 order by attempt_number", [ann.registrationId]);
    expect(rows).toEqual([{ status: "invalidated", makeup_of: null }, { status: "in_progress", makeup_of: ann.attemptId }]);
  });

  it("cancelling a round invalidates its attempts and blocks starts and results", async () => {
    const c = await competition();
    await participant(c, "Ann", 5);
    const res = await call(env.app, headJudge, "POST", `/t/${A.tenantId}/competitions/${c.id}/emergency/cancel-round`, { roundId: c.qualifying, reason: "Paper leaked" });
    expect(res.body.invalidated).toBe(1);
    expect((await compute(c)).body.error.details.reason).toBe("round_cancelled");
    const ben = await register(env.app, "ben-parent");
    const child = (await call(env.app, ben, "POST", "/me/children", { givenName: "Ben", dateOfBirth: "2016-04-01" })).body.child.id;
    const reg = await call(env.app, ben, "POST", "/me/registrations", { competitionId: c.id, studentId: child, groupId: c.group, grade: "P4", contentLocale: "en", consent: { accepted: true, version: "v1" } });
    expect((await call(env.app, ben, "POST", "/me/attempts", { registrationId: reg.body.registration.id, roundId: c.qualifying, deviceId: "device-ben-xxxxxxxx" })).body.error.details.reason).toBe("round_cancelled");
  });
});

describe("integrity review", () => {
  it("judges review and recommend; only the Head Judge disqualifies; open cases block approval", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 9, { submit: false });
    await call(env.app, ann.parent, "POST", `/me/attempts/${ann.attemptId}/events`, { sessionId: ann.sessionId, events: Array(12).fill(0).map(() => ({ type: "tab_hidden" })).concat([{ type: "paste" }, { type: "paste" }]) });
    await call(env.app, ann.parent, "POST", `/me/attempts/${ann.attemptId}/submit`, { sessionId: ann.sessionId });
    await participant(c, "Ben", 5);
    await moveRound(c, 0, 3_600_000, 60_000);

    const cases = await call(env.app, judge, "GET", `/t/${A.tenantId}/competitions/${c.id}/risk-cases?status=flagged`);
    const caseId = cases.body.riskCases[0].id;
    const id = (await compute(c)).body.version.id;
    await call(env.app, A.admin, "POST", v(id, "/submit"));
    await call(env.app, judge, "POST", v(id, "/reviews"), { recommendation: "approve" });
    const blocked = await call(env.app, headJudge, "POST", v(id, "/approve"));
    expect(blocked.body.error.details).toMatchObject({ reason: "unresolved_items", openCases: [{ riskCaseId: caseId, status: "flagged" }] });

    expect((await call(env.app, judge, "POST", `/t/${A.tenantId}/risk-cases/${caseId}/reviews`, { recommendation: "disqualify", note: "Pasted answers on 2 items while tab hidden" })).status).toBe(201);
    expect((await call(env.app, judge, "POST", `/t/${A.tenantId}/risk-cases/${caseId}/decision`, { decision: "disqualified", reason: "x".repeat(5) })).status).toBe(403);
    const decided = await call(env.app, headJudge, "POST", `/t/${A.tenantId}/risk-cases/${caseId}/decision`, { decision: "disqualified", reason: "Confirmed external help" });
    expect(decided.body.recalculatedVersions).toHaveLength(1);
    const recalculated = (await call(env.app, judge, "GET", v(decided.body.recalculatedVersions[0]))).body;
    expect(recalculated.entries.find((e: { registrationId: string }) => e.registrationId === ann.registrationId)).toMatchObject({ status: "disqualified", rank: null, qualified: false });
    expect((await call(env.app, judge, "GET", `/t/${A.tenantId}/risk-cases/${caseId}`)).body.reviews.map((r: { kind: string }) => r.kind)).toEqual(["recommendation", "decision"]);
  });

  it("a judge can open a case on any attempt; cleared cases unblock approval", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 5);
    const opened = await call(env.app, judge, "POST", `/t/${A.tenantId}/attempts/${ann.attemptId}/risk-case`, { note: "Invigilator reported talking" });
    expect(opened.body.riskCase.status).toBe("under_review");
    expect((await call(env.app, judge, "POST", `/t/${A.tenantId}/attempts/${ann.attemptId}/risk-case`, { note: "again" })).status).toBe(409);
    expect((await call(env.app, judge, "POST", `/t/${A.tenantId}/risk-cases/${opened.body.riskCase.id}/decision`, { decision: "cleared", reason: "Was asking for a pencil" })).body.status).toBe("cleared");
  });
});

describe("manual grading", () => {
  it("custom questions wait for a judge; regrading an auto-graded answer needs the Head Judge", async () => {
    const c = await competition({ content: manualVersion, questionCount: 5, formats: ["single_choice", "custom"] });
    const ann = await participant(c, "Ann", 4);
    await moveRound(c, 0, 3_600_000, 60_000);
    const detail = await call(env.app, judge, "GET", `/t/${A.tenantId}/attempts/${ann.attemptId}`);
    expect(detail.body.attempt.scoreStatus).toBe("pending_manual");
    const custom = detail.body.questions.find((q: { contentType: string }) => q.contentType === "custom");

    const id = (await compute(c)).body.version.id;
    await call(env.app, A.admin, "POST", v(id, "/submit"));
    await call(env.app, judge, "POST", v(id, "/reviews"), { recommendation: "approve" });
    expect((await call(env.app, headJudge, "POST", v(id, "/approve"))).body.error.details.pending).toEqual([{ attemptId: ann.attemptId, scoreStatus: "pending_manual" }]);

    const graded = await call(env.app, judge, "POST", `/t/${A.tenantId}/attempts/${ann.attemptId}/grades`, { itemId: custom.itemId, fraction: 1, note: "Stroke order correct" });
    expect(graded.body).toMatchObject({ scoreStatus: "scored", score: { totalScore: 5 } });
    const choice = detail.body.questions.find((q: { contentType: string }) => q.contentType === "single_choice");
    expect((await call(env.app, judge, "POST", `/t/${A.tenantId}/attempts/${ann.attemptId}/grades`, { itemId: choice.itemId, fraction: 0, note: "Reconsidered" })).status).toBe(403);
    expect((await call(env.app, headJudge, "POST", `/t/${A.tenantId}/attempts/${ann.attemptId}/grades`, { itemId: choice.itemId, fraction: 0, note: "Appeal rejected: wrong answer accepted" })).body.score.totalScore).toBe(4);
  });
});

describe("publication settings", () => {
  it("never: no leaderboard and no family results; full names when chosen", async () => {
    const c = await competition();
    const ann = await participant(c, "Ann", 6);
    await moveRound(c, 0, 3_600_000, 60_000);
    await call(env.app, A.admin, "PATCH", `/t/${A.tenantId}/competitions/${c.id}/results-settings`, { resultsPublication: "never" });
    await publish(c, (await compute(c)).body.version.id);
    expect((await call(env.app, null, "GET", `/competitions/${c.id}/leaderboard?roundId=${c.qualifying}&groupId=${c.group}`)).status).toBe(404);
    expect((await call(env.app, ann.parent, "GET", "/me/results")).body.results).toEqual([]);

    await call(env.app, A.admin, "PATCH", `/t/${A.tenantId}/competitions/${c.id}/results-settings`, { resultsPublication: "after_competition_ends" });
    expect((await call(env.app, null, "GET", `/competitions/${c.id}/leaderboard?roundId=${c.qualifying}&groupId=${c.group}`)).status).toBe(404);
    await moveRound(c, 1, 7_200_000, 3_600_000);
    await call(env.app, A.admin, "PATCH", `/t/${A.tenantId}/competitions/${c.id}/results-settings`, { leaderboardPrivacy: "full_name" });
    const board = await call(env.app, null, "GET", `/competitions/${c.id}/leaderboard?roundId=${c.qualifying}&groupId=${c.group}`);
    expect(board.body.entries[0].name).toBe("Ann Lee");
  });

  it("a live provisional leaderboard is shown only when turned on", async () => {
    const c = await competition();
    await participant(c, "Ann", 6);
    await compute(c);
    const url = `/competitions/${c.id}/leaderboard?roundId=${c.qualifying}&groupId=${c.group}`;
    expect((await call(env.app, null, "GET", url)).status).toBe(404);
    await call(env.app, A.admin, "PATCH", `/t/${A.tenantId}/competitions/${c.id}/results-settings`, { liveLeaderboard: true, leaderboardPrivacy: "anonymous_code" });
    const live = await call(env.app, null, "GET", url);
    expect(live.body).toMatchObject({ official: false, provisional: true });
    expect(live.body.entries[0].name).toMatch(/^P-/);
  });
});
