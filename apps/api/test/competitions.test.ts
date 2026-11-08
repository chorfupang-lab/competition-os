import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { standardTemplate, type CompetitionConfig } from "@cos/core";
import { withContext } from "@cos/db";
import { call, createPlatformAdmin, createTenant, register, unique, type Session, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let platform: Session;
let A: TenantFixture;
let B: TenantFixture;

beforeAll(async () => {
  platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "CompA");
  B = await createTenant(env, platform, "CompB");
});

const base = (t: TenantFixture) => `/t/${t.tenantId}/competitions`;

async function createCompetition(t: TenantFixture, extra: Record<string, unknown> = {}) {
  const res = await call(env.app, t.admin, "POST", base(t), { slug: unique("comp"), name: "Mandarin Speech Cup", feeMode: "free", ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { competition: res.body.competition, draft: res.body.draft };
}

async function publish(t: TenantFixture, competitionId: string, versionId: string, note?: string) {
  return call(env.app, t.admin, "POST", `${base(t)}/${competitionId}/versions/${versionId}/publish`, note ? { note } : {});
}

describe("creating competitions", () => {
  it("starts with a draft version 1 from the standard template", async () => {
    const { competition, draft } = await createCompetition(A);
    expect(competition).toMatchObject({ status: "draft", feeMode: "free", currency: null, timezone: "Asia/Hong_Kong", interfaceLocales: ["zh-Hant"], currentVersionId: null });
    expect(draft).toMatchObject({ versionNumber: 1, status: "draft", revision: 1, issues: [] });
    expect(draft.config.groups.map((g: { key: string }) => g.key)).toEqual(["kindergarten", "primary", "secondary", "open"]);
  });

  it("uses the tenant currency for paid competitions and requires one", async () => {
    const { competition } = await createCompetition(A, { feeMode: "paid" });
    expect(competition.currency).toBe("HKD");
    const t = await createTenant(env, platform, "NoCurrency");
    await env.owner.query("update tenants set default_currency = null where id = $1", [t.tenantId]);
    const res = await call(env.app, t.admin, "POST", base(t), { slug: unique("c"), name: "X", feeMode: "paid" });
    expect(res.status).toBe(400);
  });

  it("validates timezone, slug uniqueness and the initial config", async () => {
    expect((await call(env.app, A.admin, "POST", base(A), { slug: unique("c"), name: "X", feeMode: "free", timezone: "Mars/Olympus" })).status).toBe(400);
    const slug = unique("dup");
    await createCompetition(A, { slug });
    expect((await call(env.app, A.admin, "POST", base(A), { slug, name: "X", feeMode: "free" })).status).toBe(409);
    const bad = await call(env.app, A.admin, "POST", base(A), { slug: unique("c"), name: "X", feeMode: "free", config: { groups: [], rounds: [] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["config.groups", "config.rounds"]));
  });
});

describe("drafts, validation and publishing", () => {
  it("saves drafts with revision checks and reports issues without blocking the save", async () => {
    const { competition, draft } = await createCompetition(A);
    const url = `${base(A)}/${competition.id}/versions/${draft.id}/config`;
    const config: CompetitionConfig = structuredClone(draft.config);
    config.rounds[0]!.closesAt = config.rounds[0]!.opensAt;

    const saved = await call(env.app, A.admin, "PUT", url, { revision: 1, config });
    expect(saved.status).toBe(200);
    expect(saved.body.version.revision).toBe(2);
    expect(saved.body.version.issues.map((i: { code: string }) => i.code)).toContain("WINDOW_INVALID");

    const stale = await call(env.app, A.admin, "PUT", url, { revision: 1, config });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toEqual({ reason: "stale_revision", currentRevision: 2 });

    const blocked = await publish(A, competition.id, draft.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.reason).toBe("config_has_errors");
  });

  it("publishes, locks the version, and lists it in the public catalog", async () => {
    const { competition, draft } = await createCompetition(A);
    const res = await publish(A, competition.id, draft.id);
    expect(res.status).toBe(200);
    expect(res.body.competition).toMatchObject({ status: "published", currentVersionId: draft.id });

    // Locked in the API ...
    const edit = await call(env.app, A.admin, "PUT", `${base(A)}/${competition.id}/versions/${draft.id}/config`, { revision: 1, config: draft.config });
    expect(edit.status).toBe(409);
    expect(edit.body.error.details.reason).toBe("version_locked");
    // ... and in the database.
    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => tx.updateTable("competition_versions").set({ config: "{}" }).where("id", "=", draft.id).execute()),
    ).rejects.toThrow(/cannot be changed/);

    const catalog = await call(env.app, null, "GET", "/competitions?limit=100");
    const listed = catalog.body.competitions.find((c: { id: string }) => c.id === competition.id);
    expect(listed).toBeDefined();
    expect(listed.organizer.name).toBe("CompA");
    expect(listed.groups).toHaveLength(4);
    // Internal settings are not public.
    expect(JSON.stringify(listed)).not.toContain("contentBankVersionId");
    expect(JSON.stringify(listed)).not.toContain("difficultyMultipliers");
    expect(listed.rounds[0].groups[0]).toEqual({ groupId: expect.any(String), durationSeconds: 1800, questionCount: 20, questionFormats: ["single_choice"] });
  });

  it("a new version needs a change note, supersedes the old one, and records the diff", async () => {
    const { competition, draft } = await createCompetition(A);
    await publish(A, competition.id, draft.id);
    const v2 = await call(env.app, A.admin, "POST", `${base(A)}/${competition.id}/versions`);
    expect(v2.status).toBe(201);
    expect(v2.body.version).toMatchObject({ versionNumber: 2, status: "draft" });
    expect((await call(env.app, A.admin, "POST", `${base(A)}/${competition.id}/versions`)).status).toBe(409);

    const config: CompetitionConfig = structuredClone(v2.body.version.config);
    config.rounds[1]!.groups[0]!.questionCount = 40;
    await call(env.app, A.admin, "PUT", `${base(A)}/${competition.id}/versions/${v2.body.version.id}/config`, { revision: 1, config });

    const noNote = await publish(A, competition.id, v2.body.version.id);
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.code).toBe("REASON_REQUIRED");
    const ok = await publish(A, competition.id, v2.body.version.id, "Longer final for kindergarten");
    expect(ok.status).toBe(200);

    const detail = await call(env.app, A.admin, "GET", `${base(A)}/${competition.id}`);
    expect(detail.body.versions.map((v: { versionNumber: number; status: string }) => `${v.versionNumber}:${v.status}`)).toEqual(["2:published", "1:superseded"]);

    const logs = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/audit-logs?action=competition.version_published&limit=500`);
    const entry = logs.body.auditLogs.find((l: { targetId: string }) => l.targetId === v2.body.version.id);
    expect(entry).toMatchObject({ reason: "Longer final for kindergarten", after: { versionNumber: 2, changes: { rounds: { changed: ["final"] } } } });
  });

  it("rounds that have opened cannot be changed by a planned version", async () => {
    const config = standardTemplate();
    const past = Date.now() - 3_600_000;
    config.rounds[0]!.opensAt = new Date(past).toISOString();
    const { competition, draft } = await createCompetition(A, { config });
    expect(draft.issues.map((i: { code: string }) => i.code)).toEqual(["OPENS_IN_PAST"]);
    expect((await publish(A, competition.id, draft.id)).status).toBe(200);

    const v2 = (await call(env.app, A.admin, "POST", `${base(A)}/${competition.id}/versions`)).body.version;
    const changed: CompetitionConfig = structuredClone(v2.config);
    changed.rounds[0]!.groups[0]!.durationSeconds = 600;
    const saved = await call(env.app, A.admin, "PUT", `${base(A)}/${competition.id}/versions/${v2.id}/config`, { revision: 1, config: changed });
    expect(saved.body.version.issues.map((i: { code: string }) => i.code)).toContain("ROUND_LOCKED");
    const res = await publish(A, competition.id, v2.id, "Shorter qualifier");
    expect(res.status).toBe(409);
  });

  it("locks fee mode, currency and timezone after the first publish", async () => {
    const { competition, draft } = await createCompetition(A, { feeMode: "paid", currency: "USD" });
    expect((await call(env.app, A.admin, "PATCH", `${base(A)}/${competition.id}`, { currency: "THB" })).status).toBe(200);
    await publish(A, competition.id, draft.id);
    const res = await call(env.app, A.admin, "PATCH", `${base(A)}/${competition.id}`, { currency: "HKD", name: "Renamed" });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: "locked_after_publish", fields: ["currency"] });
    expect((await call(env.app, A.admin, "PATCH", `${base(A)}/${competition.id}`, { name: "Renamed" })).body.competition.name).toBe("Renamed");
  });
});

describe("catalog visibility", () => {
  it("hides private, cancelled and suspended-tenant competitions; unlisted is reachable by id only", async () => {
    const t = await createTenant(env, platform, "Visibility");
    const make = async (visibility: string) => {
      const { competition, draft } = await createCompetition(t, { visibility });
      await publish(t, competition.id, draft.id);
      return competition.id as string;
    };
    const pub = await make("public");
    const unlisted = await make("unlisted");
    const priv = await make("private");
    const listedIds = async () => (await call(env.app, null, "GET", "/competitions?limit=100")).body.competitions.map((c: { id: string }) => c.id);

    let ids = await listedIds();
    expect(ids).toContain(pub);
    expect(ids).not.toContain(unlisted);
    expect(ids).not.toContain(priv);
    expect((await call(env.app, null, "GET", `/competitions/${unlisted}`)).status).toBe(200);
    expect((await call(env.app, null, "GET", `/competitions/${priv}`)).status).toBe(404);

    expect((await call(env.app, t.admin, "POST", `${base(t)}/${pub}/cancel`, {})).status).toBe(400);
    expect((await call(env.app, t.admin, "POST", `${base(t)}/${pub}/cancel`, { reason: "Venue unavailable" })).status).toBe(200);
    expect(await listedIds()).not.toContain(pub);

    await call(env.app, platform, "POST", `/platform/tenants/${t.tenantId}/status`, { status: "suspended", reason: "Test" });
    expect((await call(env.app, null, "GET", `/competitions/${unlisted}`)).status).toBe(404);
  });

  it("drafts are never public", async () => {
    const { competition } = await createCompetition(A);
    expect((await call(env.app, null, "GET", `/competitions/${competition.id}`)).status).toBe(404);
  });
});

describe("isolation and competition-scoped roles", () => {
  it("another tenant cannot see or reference a competition", async () => {
    const { competition } = await createCompetition(A);
    expect((await call(env.app, B.admin, "GET", `${base(A)}/${competition.id}`)).status).toBe(404);
    expect((await call(env.app, B.admin, "GET", `${base(B)}/${competition.id}`)).status).toBe(404);
    const list = await call(env.app, B.admin, "GET", base(B));
    expect(list.body.competitions.map((c: { id: string }) => c.id)).not.toContain(competition.id);
    const u = await register(env.app, "u");
    const grant = await call(env.app, B.admin, "POST", `/t/${B.tenantId}/members`, { email: u.email, role: "judge", competitionId: competition.id });
    expect(grant.status).toBe(404);
  });

  it("a competition-scoped admin manages only that competition", async () => {
    const one = await createCompetition(A);
    const two = await createCompetition(A);
    const organizer = await register(env.app, "organizer");
    const grant = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: organizer.email, role: "competition_admin", competitionId: one.competition.id });
    expect(grant.status).toBe(201);

    const list = await call(env.app, organizer, "GET", base(A));
    expect(list.body.competitions.map((c: { id: string }) => c.id)).toEqual([one.competition.id]);
    expect((await call(env.app, organizer, "PATCH", `${base(A)}/${one.competition.id}`, { name: "Mine" })).status).toBe(200);
    expect((await publish({ ...A, admin: organizer }, one.competition.id, one.draft.id)).status).toBe(200);

    expect((await call(env.app, organizer, "GET", `${base(A)}/${two.competition.id}`)).status).toBe(404);
    expect((await call(env.app, organizer, "POST", base(A), { slug: unique("c"), name: "New", feeMode: "free" })).status).toBe(403);
    expect((await call(env.app, organizer, "GET", `/t/${A.tenantId}/members`)).status).toBe(403);
    expect((await call(env.app, organizer, "GET", `/t/${A.tenantId}/students`)).status).toBe(403);

    const tenant = await call(env.app, organizer, "GET", `/t/${A.tenantId}`);
    expect(tenant.body.roles).toEqual([]);
    expect(tenant.body.competitionRoles).toEqual({ [one.competition.id]: ["competition_admin"] });
  });

  it("a competition-scoped Head Judge holds result override only there", async () => {
    const { competition } = await createCompetition(A);
    const hj = await register(env.app, "hj");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: hj.email, role: "head_judge", competitionId: competition.id });
    const detail = await call(env.app, hj, "GET", `${base(A)}/${competition.id}`);
    expect(detail.body.permissions).toContain("result.override");
    expect(detail.body.permissions).not.toContain("competitions.manage");
    expect((await call(env.app, hj, "GET", `/t/${A.tenantId}`)).body.permissions).not.toContain("result.override");
    expect((await call(env.app, hj, "PATCH", `${base(A)}/${competition.id}`, { name: "x" })).status).toBe(403);
  });
});

describe("rule simulation", () => {
  it("ranks sample scores and applies the qualifying round's rule (top 20%)", async () => {
    const { competition, draft } = await createCompetition(A);
    const round = draft.config.rounds[0];
    const groupId = round.groups[1].groupId;
    const participants = Array.from({ length: 10 }, (_, i) => ({
      participantId: `p${i}`,
      totalScore: 100 - i * 5,
      accuracy: 0.9,
      timeMs: 60_000,
      submittedAt: "2026-12-01T10:00:00Z",
      scopes: { school: i % 2 ? "s1" : "s2" },
    }));
    participants[9]!.totalScore = 95; // ties with p1

    const res = await call(env.app, A.admin, "POST", `${base(A)}/${competition.id}/versions/${draft.id}/simulate`, { roundId: round.id, groupId, participants });
    expect(res.status).toBe(200);
    expect(res.body.ranking.ranked.slice(0, 3).map((r: { participantId: string; rank: number }) => `${r.participantId}:${r.rank}`)).toEqual(["p0:1", "p1:2", "p9:2"]);
    // 10 × 20% = 2 slots; p1 and p9 share rank 2 and ties are included.
    expect(res.body.qualification.filter((q: { qualified: boolean }) => q.qualified).map((q: { participantId: string }) => q.participantId)).toEqual(["p0", "p1", "p9"]);

    const badOverride = await call(env.app, A.admin, "POST", `${base(A)}/${competition.id}/versions/${draft.id}/simulate`, {
      roundId: round.id, groupId, participants, overrides: [{ participantId: "p5", action: "include", reason: "wildcard" }],
    });
    expect(badOverride.status).toBe(400);
    expect(badOverride.body.error.details[0].message).toMatch(/exceed/);
  });
});

describe("eligibility", () => {
  it("staff can check a date of birth and grade against every group", async () => {
    const { competition } = await createCompetition(A);
    const res = await call(env.app, A.admin, "POST", `${base(A)}/${competition.id}/eligibility`, { grade: "P4" });
    const byKey = Object.fromEntries(res.body.groups.map((g: { key: string; eligible: boolean }) => [g.key, g.eligible]));
    expect(byKey).toEqual({ kindergarten: false, primary: true, secondary: false, open: true });
  });

  it("a parent checks their own child against a published competition", async () => {
    const { competition, draft } = await createCompetition(A);
    const parent = await register(env.app, "elig-parent");
    const child = (await call(env.app, parent, "POST", "/me/children", { givenName: "Ming", dateOfBirth: "2016-04-01" })).body.child;

    const unpublished = await call(env.app, parent, "GET", `/me/children/${child.id}/eligibility/${competition.id}?grade=P4`);
    expect(unpublished.status).toBe(404);

    await publish(A, competition.id, draft.id);
    const res = await call(env.app, parent, "GET", `/me/children/${child.id}/eligibility/${competition.id}?grade=${encodeURIComponent("小四")}`);
    expect(res.status).toBe(200);
    const primary = res.body.groups.find((g: { key: string }) => g.key === "primary");
    expect(primary).toMatchObject({ eligible: true, failures: [] });
    const secondary = res.body.groups.find((g: { key: string }) => g.key === "secondary");
    expect(secondary.failures[0]).toMatchObject({ code: "GRADE_TOO_LOW" });

    const noGrade = await call(env.app, parent, "GET", `/me/children/${child.id}/eligibility/${competition.id}`);
    expect(noGrade.body.groups.find((g: { key: string }) => g.key === "primary").failures[0].code).toBe("MISSING_GRADE");

    const stranger = await register(env.app, "stranger");
    expect((await call(env.app, stranger, "GET", `/me/children/${child.id}/eligibility/${competition.id}`)).status).toBe(404);
    expect((await call(env.app, parent, "GET", `/me/children/${child.id}/eligibility/${randomUUID()}`)).status).toBe(404);
  });
});
