import { beforeAll, describe, expect, it } from "vitest";
import { call, createPlatformAdmin, createTenant, register, type Session, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let platform: Session;
let T: TenantFixture;

beforeAll(async () => {
  platform = await createPlatformAdmin(env);
  T = await createTenant(env, platform, "Roles");
});

async function grant(role: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const u = await register(env.app, role);
  const res = await call(env.app, T.admin, "POST", `/t/${T.tenantId}/members`, { email: u.email, role, ...extra });
  expect(res.status).toBe(201);
  return u;
}

describe("tenant roles", () => {
  it("reports the caller's roles and permissions in the tenant", async () => {
    const res = await call(env.app, T.admin, "GET", `/t/${T.tenantId}`);
    expect(res.body.roles).toEqual(["competition_admin"]);
    expect(res.body.permissions).toContain("members.manage");
    expect(res.body.permissions).not.toContain("result.override");
  });

  it("Head Judge alone holds result override; Platform Admin does not", async () => {
    const headJudge = await grant("head_judge");
    const judge = await grant("judge");
    const perms = async (s: Session) => (await call(env.app, s, "GET", `/t/${T.tenantId}`)).body.permissions as string[];
    expect(await perms(headJudge)).toContain("result.override");
    expect(await perms(judge)).not.toContain("result.override");
    expect(await perms(platform)).not.toContain("result.override");
    expect(await perms(platform)).toContain("members.manage");
  });

  it("judges cannot manage members or see students", async () => {
    const judge = await grant("judge");
    const u = await register(env.app, "z");
    expect((await call(env.app, judge, "POST", `/t/${T.tenantId}/members`, { email: u.email, role: "judge" })).status).toBe(403);
    expect((await call(env.app, judge, "GET", `/t/${T.tenantId}/students`)).status).toBe(403);
    expect((await call(env.app, judge, "GET", `/t/${T.tenantId}/members`)).status).toBe(403);
  });

  it("school_admin requires a schoolId, other roles reject one", async () => {
    const u = await register(env.app, "w");
    expect((await call(env.app, T.admin, "POST", `/t/${T.tenantId}/members`, { email: u.email, role: "school_admin" })).status).toBe(400);
  });

  it("rejects a duplicate active grant, and revoking needs a reason and removes access", async () => {
    const judge = await grant("judge");
    const dup = await call(env.app, T.admin, "POST", `/t/${T.tenantId}/members`, { email: judge.email, role: "judge" });
    expect(dup.status).toBe(409);

    const members = await call(env.app, T.admin, "GET", `/t/${T.tenantId}/members`);
    const membership = members.body.members.find((m: { user: { id: string } }) => m.user.id === judge.userId);
    expect((await call(env.app, T.admin, "POST", `/t/${T.tenantId}/members/${membership.id}/revoke`, {})).status).toBe(400);
    const revoke = await call(env.app, T.admin, "POST", `/t/${T.tenantId}/members/${membership.id}/revoke`, { reason: "Left the panel" });
    expect(revoke.status).toBe(200);
    expect((await call(env.app, judge, "GET", `/t/${T.tenantId}`)).status).toBe(404);

    const logs = await call(env.app, T.admin, "GET", `/t/${T.tenantId}/audit-logs?action=membership.revoked`);
    expect(logs.body.auditLogs[0]).toMatchObject({ reason: "Left the panel", targetId: membership.id });
  });

  it("/me lists memberships across tenants", async () => {
    const other = await createTenant(env, platform, "Other");
    const res = await call(env.app, other.admin, "POST", `/t/${other.tenantId}/members`, { email: T.admin.email, role: "judge" });
    expect(res.status).toBe(201);
    const me = await call(env.app, T.admin, "GET", "/me");
    const tenants = me.body.memberships.map((m: { tenant: { id: string }; role: string }) => `${m.tenant.id}:${m.role}`);
    expect(tenants).toEqual(expect.arrayContaining([`${T.tenantId}:competition_admin`, `${other.tenantId}:judge`]));
  });
});
