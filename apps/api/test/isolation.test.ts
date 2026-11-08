import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { withContext } from "@cos/db";
import {
  call,
  createPlatformAdmin,
  createTenant,
  register,
  type Session,
  type TenantFixture,
  useTestEnv,
} from "./helpers.ts";

const env = useTestEnv();

/**
 * Fixture:
 *   Tenant A: schools A1, A2; one student on each roster; School Admin of A1.
 *   Tenant B: school B1 with one student.
 *   A parent with a child who is connected to no tenant.
 */
let platform: Session;
let A: TenantFixture;
let B: TenantFixture;
let schoolA1: string;
let schoolA2: string;
let schoolB1: string;
let studentA1: string;
let studentA2: string;
let studentB1: string;
let schoolAdminA1: Session;
let parent: Session;
let childId: string;

async function addSchool(t: TenantFixture, name: string): Promise<string> {
  const res = await call(env.app, t.admin, "POST", `/t/${t.tenantId}/schools`, { name });
  expect(res.status).toBe(201);
  return res.body.school.id;
}

async function addRosterStudent(actor: Session, tenantId: string, schoolId: string, givenName: string): Promise<string> {
  const res = await call(env.app, actor, "POST", `/t/${tenantId}/schools/${schoolId}/students`, {
    students: [{ givenName, familyName: "Chan", dateOfBirth: "2015-03-01", grade: "P4" }],
  });
  expect(res.status).toBe(201);
  return res.body.created[0].studentId;
}

beforeAll(async () => {
  platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "Alpha");
  B = await createTenant(env, platform, "Beta");
  schoolA1 = await addSchool(A, "Alpha Primary 1");
  schoolA2 = await addSchool(A, "Alpha Primary 2");
  schoolB1 = await addSchool(B, "Beta Primary");
  studentA1 = await addRosterStudent(A.admin, A.tenantId, schoolA1, "Ada");
  studentA2 = await addRosterStudent(A.admin, A.tenantId, schoolA2, "Ben");
  studentB1 = await addRosterStudent(B.admin, B.tenantId, schoolB1, "Cleo");

  schoolAdminA1 = await register(env.app, "school-admin");
  const grant = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, {
    email: schoolAdminA1.email,
    role: "school_admin",
    schoolId: schoolA1,
  });
  expect(grant.status).toBe(201);

  parent = await register(env.app, "parent");
  const child = await call(env.app, parent, "POST", "/me/children", { givenName: "Dora", dateOfBirth: "2016-05-05" });
  expect(child.status).toBe(201);
  childId = child.body.child.id;
});

describe("tenant isolation (API)", () => {
  it("a tenant admin cannot open another tenant at all", async () => {
    for (const path of ["", "/schools", "/students", "/members", "/audit-logs", `/students/${studentB1}`]) {
      const res = await call(env.app, A.admin, "GET", `/t/${B.tenantId}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("a non-existent tenant looks the same as a foreign one", async () => {
    const res = await call(env.app, A.admin, "GET", `/t/00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
  });

  it("lists only the tenant's own students and schools", async () => {
    const students = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/students`);
    expect(students.body.students.map((s: { id: string }) => s.id).sort()).toEqual([studentA1, studentA2].sort());
    const schools = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/schools`);
    expect(schools.body.schools.map((s: { id: string }) => s.id).sort()).toEqual([schoolA1, schoolA2].sort());
  });

  it("cannot reach another tenant's school through its own tenant path", async () => {
    const res = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/schools/${schoolB1}/students`, {
      students: [{ givenName: "Intruder" }],
    });
    expect(res.status).toBe(404);
    const read = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/schools/${schoolB1}/students`);
    expect(read.body.students).toEqual([]);
    const student = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/students/${studentB1}`);
    expect(student.status).toBe(404);
  });

  it("cannot grant a role for another tenant's school", async () => {
    const u = await register(env.app, "x");
    const res = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: u.email, role: "school_admin", schoolId: schoolB1 });
    expect(res.status).toBe(404);
  });

  it("tenant audit logs contain only that tenant's entries", async () => {
    const res = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/audit-logs?limit=500`);
    expect(res.status).toBe(200);
    expect(res.body.auditLogs.length).toBeGreaterThan(0);
    for (const log of res.body.auditLogs) expect(log.tenantId).toBe(A.tenantId);
  });
});

describe("school scoping", () => {
  it("a School Admin sees only their own school and roster", async () => {
    const schools = await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/schools`);
    expect(schools.body.schools.map((s: { id: string }) => s.id)).toEqual([schoolA1]);

    const own = await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/schools/${schoolA1}/students`);
    expect(own.body.students.map((s: { id: string }) => s.id)).toEqual([studentA1]);

    const other = await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/schools/${schoolA2}/students`);
    expect(other.status).toBe(403);
  });

  it("a School Admin cannot list tenant-wide students or see other schools' students", async () => {
    expect((await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/students`)).status).toBe(403);
    expect((await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/students/${studentA1}`)).status).toBe(200);
    expect((await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/students/${studentA2}`)).status).toBe(404);
  });

  it("a School Admin can bulk-add to their own school only", async () => {
    const ok = await call(env.app, schoolAdminA1, "POST", `/t/${A.tenantId}/schools/${schoolA1}/students`, {
      students: [{ givenName: "Eve" }, { givenName: "Finn" }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.created).toHaveLength(2);
    const denied = await call(env.app, schoolAdminA1, "POST", `/t/${A.tenantId}/schools/${schoolA2}/students`, {
      students: [{ givenName: "Gus" }],
    });
    expect(denied.status).toBe(403);
  });

  it("a School Admin cannot manage members, schools or read the audit log", async () => {
    const u = await register(env.app, "y");
    expect((await call(env.app, schoolAdminA1, "POST", `/t/${A.tenantId}/members`, { email: u.email, role: "judge" })).status).toBe(403);
    expect((await call(env.app, schoolAdminA1, "POST", `/t/${A.tenantId}/schools`, { name: "New" })).status).toBe(403);
    expect((await call(env.app, schoolAdminA1, "GET", `/t/${A.tenantId}/audit-logs`)).status).toBe(403);
  });
});

describe("student privacy across tenants", () => {
  it("an organizer does not see a child who is connected only to a parent", async () => {
    expect((await call(env.app, A.admin, "GET", `/t/${A.tenantId}/students/${childId}`)).status).toBe(404);
  });

  it("a parent sees only their own children", async () => {
    const other = await register(env.app, "other-parent");
    expect((await call(env.app, other, "GET", `/me/children/${childId}`)).status).toBe(404);
    expect((await call(env.app, other, "GET", "/me/children")).body.children).toEqual([]);
    expect((await call(env.app, parent, "GET", `/me/children/${childId}`)).status).toBe(200);
  });
});

describe("tenant isolation (database row-level security)", () => {
  it("queries without a tenant filter still return only the current tenant's rows", async () => {
    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    const rows = await withContext(env.db, ctx, async (tx) => ({
      schools: await tx.selectFrom("schools").select("tenant_id").execute(),
      students: await tx.selectFrom("students").select("id").execute(),
      links: await tx.selectFrom("school_students").select("tenant_id").execute(),
      audit: await tx.selectFrom("audit_logs").select("tenant_id").where("tenant_id", "is not", null).execute(),
    }));
    expect(new Set(rows.schools.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    expect(new Set(rows.links.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    expect(new Set(rows.audit.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    const ids = rows.students.map((r) => r.id);
    expect(ids).toContain(studentA1);
    expect(ids).not.toContain(studentB1);
    expect(ids).not.toContain(childId);
  });

  it("no context means no rows", async () => {
    const empty = { userId: null, tenantId: null, platformAdmin: false, tenantWide: false, schoolIds: [] };
    const rows = await withContext(env.db, empty, async (tx) => ({
      tenants: await tx.selectFrom("tenants").select("id").execute(),
      students: await tx.selectFrom("students").select("id").execute(),
      users: await tx.selectFrom("users").select("id").execute(),
    }));
    expect(rows).toEqual({ tenants: [], students: [], users: [] });
  });

  it("refuses to write rows into another tenant", async () => {
    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => tx.insertInto("schools").values({ tenant_id: B.tenantId, name: "Sneaky", name_i18n: "{}" }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update another tenant's rows", async () => {
    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    const result = await withContext(env.db, ctx, (tx) =>
      tx.updateTable("schools").set({ name: "Renamed" }).where("id", "=", schoolB1).executeTakeFirst(),
    );
    expect(Number(result.numUpdatedRows)).toBe(0);
  });

  it("the application role cannot delete anything", async () => {
    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => tx.deleteFrom("schools").where("id", "=", schoolA1).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it("a parent cannot attach themselves to someone else's student", async () => {
    const intruder = await register(env.app, "intruder");
    const ctx = { userId: intruder.userId, tenantId: null, platformAdmin: false, tenantWide: false, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => tx.insertInto("parent_children").values({ parent_user_id: intruder.userId, student_id: studentA1 }).execute()),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("platform role protection", () => {
  it("users cannot make themselves platform admin", async () => {
    const u = await register(env.app, "climber");
    const patch = await call(env.app, u, "PATCH", "/me", { platformRole: "platform_admin" });
    expect(patch.status).toBe(200);
    expect((await call(env.app, u, "GET", "/me")).body.user.platformRole).toBeNull();
    const ctx = { userId: u.userId, tenantId: null, platformAdmin: false, tenantWide: false, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => sql`update users set platform_role = 'platform_admin' where id = ${u.userId}`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });

  it("platform routes are platform-admin only", async () => {
    expect((await call(env.app, A.admin, "GET", "/platform/tenants")).status).toBe(403);
    expect((await call(env.app, null, "GET", "/platform/tenants")).status).toBe(401);
    const res = await call(env.app, platform, "GET", "/platform/tenants");
    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([A.tenantId, B.tenantId]));
  });
});

describe("tenant suspension", () => {
  it("requires a reason, blocks members, keeps the platform admin in, and is audited", async () => {
    const t = await createTenant(env, platform, "Gamma");
    const noReason = await call(env.app, platform, "POST", `/platform/tenants/${t.tenantId}/status`, { status: "suspended" });
    expect(noReason.status).toBe(400);

    const res = await call(env.app, platform, "POST", `/platform/tenants/${t.tenantId}/status`, { status: "suspended", reason: "Unpaid invoice" });
    expect(res.status).toBe(200);
    const blocked = await call(env.app, t.admin, "GET", `/t/${t.tenantId}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("TENANT_SUSPENDED");
    expect((await call(env.app, platform, "GET", `/t/${t.tenantId}`)).status).toBe(200);

    const logs = await call(env.app, platform, "GET", `/platform/audit-logs?tenantId=${t.tenantId}&action=tenant.status_changed`);
    expect(logs.body.auditLogs[0]).toMatchObject({
      actorUserId: platform.userId,
      reason: "Unpaid invoice",
      before: { status: "active" },
      after: { status: "suspended" },
    });
  });
});

describe("audit log", () => {
  it("is append-only, even for the database owner", async () => {
    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => tx.updateTable("audit_logs").set({ reason: "edited" }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(env.owner.query("update audit_logs set reason = 'edited'")).rejects.toThrow(/append-only/);
    await expect(env.owner.query("delete from audit_logs")).rejects.toThrow(/append-only/);
  });
});
