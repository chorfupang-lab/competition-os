import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompetitionConfig } from "@cos/core";
import { runAiJobs, sweepRecordings } from "../src/lib/ai-jobs.ts";
import { call, createPlatformAdmin, createTenant, register, unique, type Session, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let A: TenantFixture;
let judge: Session;
let headJudge: Session;
let competitionVersion: string;
const skill: Record<string, string> = {};
const practiceItems: string[] = [];

const choice = (key: string, skillIds: string[]) => ({
  externalKey: key, contentType: "single_choice", baseLocale: "en", difficulty: "easy", status: "ready", skillIds,
  body: { prompt: `Q ${key}`, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionId: "b" },
});
const speak = (key: string, skillIds: string[]) => ({
  externalKey: key, contentType: "pronunciation", baseLocale: "en", difficulty: "medium", status: "ready", skillIds,
  body: { prompt: "Read aloud", targetText: "你好老師", speechLanguage: "cmn", aspects: ["tones", "finals"] },
});

beforeAll(async () => {
  const platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "Passport");
  judge = await register(env.app, "judge");
  headJudge = await register(env.app, "head-judge");
  await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: judge.email, role: "judge" });
  await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: headJudge.email, role: "head_judge" });
  const c = `/t/${A.tenantId}/content`;
  const fw = (await call(env.app, A.admin, "POST", `${c}/skill-frameworks`, { key: "mandarin", name: "Mandarin" })).body.framework.id;
  for (const key of ["tones", "finals"]) skill[key] = (await call(env.app, A.admin, "POST", `${c}/skill-frameworks/${fw}/skills`, { key, name: key === "tones" ? "Tones" : "Finals" })).body.skill.id;

  const bank = (await call(env.app, A.admin, "POST", `${c}/banks`, { key: unique("comp"), name: "Competition bank", baseLocale: "en", skillFrameworkId: fw })).body.bank.id;
  for (let i = 0; i < 6; i++) await call(env.app, A.admin, "POST", `${c}/banks/${bank}/items`, choice(`C-${i}`, [i < 3 ? skill.tones! : skill.finals!]));
  for (let i = 0; i < 2; i++) await call(env.app, A.admin, "POST", `${c}/banks/${bank}/items`, speak(`S-${i}`, [skill.tones!]));
  competitionVersion = (await call(env.app, A.admin, "POST", `${c}/banks/${bank}/versions`, {})).body.version.id;

  const practice = (await call(env.app, A.admin, "POST", `${c}/banks`, { key: unique("prac"), name: "Practice", baseLocale: "en", skillFrameworkId: fw, practiceEnabled: true })).body.bank.id;
  for (let i = 0; i < 6; i++) {
    const r = await call(env.app, A.admin, "POST", `${c}/banks/${practice}/items`, choice(`P-${i}`, [i < 4 ? skill.finals! : skill.tones!]));
    practiceItems.push(r.body.item.id);
  }
  await call(env.app, A.admin, "POST", `${c}/banks/${practice}/versions`, {});
});

interface Run {
  competitionId: string;
  roundId: string;
  groupId: string;
  versionId: string;
  parent: Session;
  childId: string;
  registrationId: string;
  attemptId: string;
  sessionId: string;
  questions: Array<{ itemId: string; contentType: string }>;
}

async function run(opts: { settings?: Record<string, unknown> } = {}): Promise<Run> {
  const base = `/t/${A.tenantId}/competitions`;
  const created = await call(env.app, A.admin, "POST", base, { slug: unique("pp"), name: "Speech Cup", feeMode: "free", contentLocales: ["en"] });
  const { competition, draft } = created.body;
  const config: CompetitionConfig = draft.config;
  const round = config.rounds[0]!;
  round.opensAt = new Date(Date.now() - 60_000).toISOString();
  round.closesAt = new Date(Date.now() + 3_600_000).toISOString();
  config.rounds[1]!.opensAt = new Date(Date.now() + 7_200_000).toISOString();
  config.rounds[1]!.closesAt = new Date(Date.now() + 10_800_000).toISOString();
  const groupId = config.groups.find((g) => g.key === "primary")!.id;
  for (const r of config.rounds) for (const g of r.groups) {
    g.enabled = g.groupId === groupId;
    g.content.contentBankVersionId = competitionVersion;
    g.questionCount = 8;
    g.questionFormats = ["single_choice", "pronunciation"];
    g.randomizeQuestions = false;
    g.scoring.partialCredit = "proportional";
  }
  await call(env.app, A.admin, "PUT", `${base}/${competition.id}/versions/${draft.id}/config`, { revision: 1, config });
  expect((await call(env.app, A.admin, "POST", `${base}/${competition.id}/versions/${draft.id}/publish`, {})).status).toBe(200);
  if (opts.settings) expect((await call(env.app, A.admin, "PATCH", `${base}/${competition.id}/ai-settings`, opts.settings)).status).toBe(200);

  const parent = await register(env.app, "parent");
  const childId = (await call(env.app, parent, "POST", "/me/children", { givenName: unique("Kid"), dateOfBirth: "2016-04-01" })).body.child.id;
  const reg = await call(env.app, parent, "POST", "/me/registrations", { competitionId: competition.id, studentId: childId, groupId, grade: "P4", contentLocale: "en", consent: { accepted: true, version: "v1" } });
  const start = await call(env.app, parent, "POST", "/me/attempts", { registrationId: reg.body.registration.id, roundId: round.id, deviceId: `device-${unique("d")}` });
  expect(start.status).toBe(201);
  return { competitionId: competition.id, roundId: round.id, groupId, versionId: draft.id, parent, childId, registrationId: reg.body.registration.id, attemptId: start.body.attempt.id, sessionId: start.body.sessionId, questions: start.body.questions };
}

const upload = (r: Run, itemId: string, audio: Buffer, seq = 1, type = "audio/webm") =>
  env.app.inject({ method: "PUT", url: `/me/attempts/${r.attemptId}/recordings/${itemId}`, headers: { ...r.parent.headers, "content-type": type, "x-session-id": r.sessionId, "x-client-seq": String(seq) }, payload: audio });

/** Answer: tones questions right, finals questions wrong; upload a recording for each pronunciation item; submit. */
async function answerAndSubmit(r: Run) {
  const choices = r.questions.filter((q) => q.contentType === "single_choice");
  const answers = [];
  for (const q of choices) {
    answers.push({ itemId: q.itemId, response: { optionId: "b" }, clientSeq: 1, timeSpentMs: 20_000 });
  }
  // Mark finals wrong: look up which items are finals through the attempt review.
  const review = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/attempts/${r.attemptId}`);
  const finalsKeys = new Set(["C-3", "C-4", "C-5"]);
  for (const a of answers) {
    const key = review.body.questions.find((q: { itemId: string }) => q.itemId === a.itemId).externalKey;
    if (finalsKeys.has(key)) a.response = { optionId: "a" };
  }
  await call(env.app, r.parent, "PUT", `/me/attempts/${r.attemptId}/answers`, { sessionId: r.sessionId, answers });
  for (const q of r.questions.filter((x) => x.contentType === "pronunciation")) {
    const res = await upload(r, q.itemId, Buffer.from(`voice-${q.itemId}`));
    expect(res.statusCode, res.body).toBe(200);
  }
  return call(env.app, r.parent, "POST", `/me/attempts/${r.attemptId}/submit`, { sessionId: r.sessionId });
}

const blobCount = () => {
  const walk = (d: string): number => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(join(d, e.name)) : 1), 0) : 0);
  return walk(env.blobDir);
};

describe("pronunciation: AI measures, a judge confirms", () => {
  it("stores the answer at once, analyses later, deletes raw voice, and never sets the official score by itself", async () => {
    const r = await run();
    const speakItem = r.questions.find((q) => q.contentType === "pronunciation")!;
    expect((await upload(r, speakItem.itemId, Buffer.from("x"), 1, "text/plain")).statusCode).toBe(400);
    expect((await upload(r, r.questions.find((q) => q.contentType === "single_choice")!.itemId, Buffer.from("x"))).statusCode).toBe(400);

    const before = blobCount();
    const submitted = await answerAndSubmit(r);
    expect(submitted.body.attempt.status).toBe("submitted");
    expect(blobCount()).toBe(before + 2);
    let detail = await call(env.app, judge, "GET", `/t/${A.tenantId}/attempts/${r.attemptId}`);
    expect(detail.body.attempt).toMatchObject({ scoreStatus: "pending_ai", score: { totalScore: 3, maxScore: 6 } });

    const jobs = await runAiJobs(env.db, env.ai);
    expect(jobs.succeeded).toBeGreaterThanOrEqual(2);
    expect(blobCount()).toBe(before);
    detail = await call(env.app, judge, "GET", `/t/${A.tenantId}/attempts/${r.attemptId}`);
    expect(detail.body.attempt.scoreStatus).toBe("pending_manual");
    expect(detail.body.attempt.score.totalScore).toBe(3);
    const speakGrade = detail.body.questions.find((q: { contentType: string }) => q.contentType === "pronunciation").grade;
    expect(speakGrade).toMatchObject({ outcome: "pending_ai", ai: { suggestedFraction: expect.any(Number) } });
    const { rows } = await env.owner.query("select status, deleted_reason from recordings where attempt_id = $1", [r.attemptId]);
    expect(rows.every((x: { status: string }) => x.status === "deleted")).toBe(true);

    // A judge confirms; the score now includes the suggestions, attributed to the judge.
    const accepted = await call(env.app, judge, "POST", `/t/${A.tenantId}/attempts/${r.attemptId}/grades/accept-ai`, { note: "Listened to a sample; suggestions fair" });
    expect(accepted.body.confirmed).toHaveLength(2);
    expect(accepted.body.scoreStatus).toBe("scored");
    const expected = 3 + accepted.body.confirmed.reduce((s: number, c: { fraction: number }) => s + c.fraction, 0);
    expect(accepted.body.score.totalScore).toBeCloseTo(expected, 3);
    const audits = await env.owner.query("select actor_user_id from audit_logs where action = 'grading.ai_confirmed' and target_id = $1", [r.attemptId]);
    expect(audits.rows).toEqual([{ actor_user_id: judge.userId }]);
  });

  it("retains voice only when the organizer chooses, with a reason, and deletes it when retention ends", async () => {
    const base = `/t/${A.tenantId}/competitions`;
    const r = await run();
    expect((await call(env.app, A.admin, "PATCH", `${base}/${r.competitionId}/ai-settings`, { voiceRetentionDays: 30 })).status).toBe(400);
    expect((await call(env.app, A.admin, "PATCH", `${base}/${r.competitionId}/ai-settings`, { voiceRetentionDays: 30, reason: "Appeals window for the final" })).status).toBe(200);
    await answerAndSubmit(r);
    await runAiJobs(env.db, env.ai);
    const { rows } = await env.owner.query("select id, status, retain_until from recordings where attempt_id = $1", [r.attemptId]);
    expect(rows.every((x: { status: string; retain_until: Date }) => x.status === "stored" && x.retain_until > new Date())).toBe(true);
    await env.owner.query("update recordings set retain_until = now() - interval '1 minute' where attempt_id = $1", [r.attemptId]);
    expect(await sweepRecordings(env.db, env.ai.blobs)).toBe(2);
    const after = await env.owner.query("select status, deleted_reason from recordings where attempt_id = $1", [r.attemptId]);
    expect(after.rows.every((x: { status: string; deleted_reason: string }) => x.status === "deleted" && x.deleted_reason === "retention_expired")).toBe(true);
  });

  it("an AI outage never blocks the participant: the job retries later", async () => {
    const r = await run();
    env.ai.pronunciation.failNext = 2;
    await answerAndSubmit(r);
    const first = await runAiJobs(env.db, env.ai);
    expect(first.retried).toBe(2);
    const { rows } = await env.owner.query("select status, attempts, last_error from ai_jobs where payload->>'recordingId' in (select id::text from recordings where attempt_id = $1)", [r.attemptId]);
    expect(rows.every((j: { status: string; attempts: number }) => j.status === "pending" && j.attempts === 1)).toBe(true);
    await env.owner.query("update ai_jobs set run_after = now() where status = 'pending'");
    expect((await runAiJobs(env.db, env.ai)).succeeded).toBeGreaterThanOrEqual(2);
  });
});

describe("Learning Passport and practice", () => {
  it("builds a skill profile, finds weak areas, and recommends practice from practice banks only", async () => {
    const r = await run();
    await answerAndSubmit(r);
    await runAiJobs(env.db, env.ai);
    await call(env.app, judge, "POST", `/t/${A.tenantId}/attempts/${r.attemptId}/grades/accept-ai`, { note: "ok" });

    const passport = await call(env.app, r.parent, "GET", `/me/passport/${r.childId}`);
    expect(passport.status).toBe(200);
    const bySkill = Object.fromEntries(passport.body.skills.map((s: { key: string; mastery: number }) => [s.key, s.mastery]));
    expect(bySkill.finals).toBe(0);
    expect(passport.body.weaknesses.map((s: { key: string }) => s.key)).toEqual(["finals"]);
    expect(passport.body.recommendedPractice.length).toBeGreaterThan(0);
    for (const p of passport.body.recommendedPractice) expect(practiceItems).toContain(p.id);
    expect(passport.body.pronunciation[0]).toMatchObject({ speechLanguage: "cmn", assessments: 2, groupAverage: null });
    expect(Object.keys(passport.body.pronunciation[0].latest.aspects).sort()).toEqual(["finals", "tones"]);

    const stranger = await register(env.app, "stranger");
    expect((await call(env.app, stranger, "GET", `/me/passport/${r.childId}`)).status).toBe(404);

    // Practice targets the weak skill, uses only practice-enabled content, and never touches official data.
    const set = await call(env.app, r.parent, "POST", "/me/practice-sets", { studentId: r.childId, size: 4 });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body.targetSkillIds).toEqual([skill.finals]);
    for (const q of set.body.questions) expect(practiceItems).toContain(q.itemId);
    expect(JSON.stringify(set.body.questions)).not.toContain("correctOptionId");
    const submit = await call(env.app, r.parent, "POST", `/me/practice-sets/${set.body.id}/submit`, { answers: set.body.questions.map((q: { itemId: string }) => ({ itemId: q.itemId, response: { optionId: "b" } })) });
    expect(submit.body.score).toMatchObject({ totalScore: 4, maxScore: 4 });
    const reviewed = await call(env.app, r.parent, "GET", `/me/practice-sets/${set.body.id}`);
    expect(reviewed.body.questions[0]).toMatchObject({ grade: { outcome: "correct" } });
    const { rows } = await env.owner.query("select count(*)::int as n from attempts where student_id = $1", [r.childId]);
    expect(rows[0].n).toBe(1);

    const later = await call(env.app, r.parent, "GET", `/me/passport/${r.childId}`);
    const finals = later.body.skills.find((s: { key: string }) => s.key === "finals");
    expect(finals.mastery).toBeGreaterThan(0);
    expect(finals.lastChange).toBe(1);
  });
});

describe("AI feedback: validated, safety-filtered, with a deterministic fallback", () => {
  it("serves valid AI feedback, and replaces unsafe or invented output with the fallback", async () => {
    const r = await run();
    await answerAndSubmit(r);
    const set = (await call(env.app, r.parent, "POST", "/me/practice-sets", { studentId: r.childId, skillIds: [skill.finals], size: 3 })).body;
    await call(env.app, r.parent, "POST", `/me/practice-sets/${set.id}/submit`, { answers: set.questions.map((q: { itemId: string }, i: number) => ({ itemId: q.itemId, response: { optionId: i === 0 ? "a" : "b" } })) });

    const url = `/me/practice-sets/${set.id}/feedback`;
    expect((await call(env.app, r.parent, "GET", url)).status).toBe(202);
    env.ai.feedback.next = { summary: "Nice work on finals — two out of three right!", strengthSkillIds: [], weaknessSkillIds: [skill.finals], encouragement: "Keep practising!", recommendedItemIds: [practiceItems[0]] };
    await runAiJobs(env.db, env.ai);
    const good = await call(env.app, r.parent, "GET", url);
    expect(good.body).toMatchObject({ status: "ready", source: "ai", feedback: { summary: "Nice work on finals — two out of three right!" } });
    const facts = env.ai.feedback.calls.at(-1) as { weaknesses: Array<{ id: string }>; practiceCandidates: Array<{ id: string }> };
    expect(facts.weaknesses.map((w) => w.id)).toEqual([skill.finals]);

    const set2 = (await call(env.app, r.parent, "POST", "/me/practice-sets", { studentId: r.childId, skillIds: [skill.finals], size: 3 })).body;
    await call(env.app, r.parent, "POST", `/me/practice-sets/${set2.id}/submit`, { answers: [] });
    await call(env.app, r.parent, "GET", `/me/practice-sets/${set2.id}/feedback`);
    env.ai.feedback.next = { summary: "This pattern suggests dyslexia; please see a doctor.", strengthSkillIds: [], weaknessSkillIds: [], encouragement: "Visit www.tutor.example for help", recommendedItemIds: ["not-an-approved-item"] };
    await runAiJobs(env.db, env.ai);
    const bad = await call(env.app, r.parent, "GET", `/me/practice-sets/${set2.id}/feedback`);
    expect(bad.body.source).toBe("fallback");
    expect(bad.body.feedback.summary).toMatch(/^You answered 0% of the questions correctly/);
    const audit = await env.owner.query("select after from audit_logs where action = 'ai.feedback_rejected' and target_id = $1", [set2.id]);
    expect(audit.rows[0].after.reasons).toEqual(expect.arrayContaining(["unapproved_recommendation", "unsafe:diagnosis", "unsafe:professional_advice", "unsafe:external_link"]));
  });

  it("official attempts get feedback only once results are visible", async () => {
    const r = await run();
    await answerAndSubmit(r);
    expect((await call(env.app, r.parent, "GET", `/me/attempts/${r.attemptId}/feedback`)).body.error.details.reason).toBe("feedback_not_available_yet");
  });
});

describe("AI usage and cost", () => {
  it("reports usage, estimated cost and job health per tenant", async () => {
    const usage = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/ai/usage`);
    expect(usage.status).toBe(200);
    const kinds = usage.body.usage.map((u: { kind: string }) => u.kind);
    expect(kinds).toEqual(expect.arrayContaining(["pronunciation", "feedback"]));
    expect(usage.body.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(usage.body.jobs.find((j: { kind: string; status: string }) => j.kind === "pronunciation" && j.status === "succeeded").count).toBeGreaterThan(0);
    expect((await call(env.app, judge, "GET", `/t/${A.tenantId}/ai/usage`)).status).toBe(403);
  });
});
