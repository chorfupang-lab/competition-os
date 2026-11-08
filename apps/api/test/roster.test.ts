import { beforeAll, describe, expect, it } from "vitest";
import { call, createPlatformAdmin, createTenant, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let T: TenantFixture;
let schoolId: string;
const url = () => `/t/${T.tenantId}/schools/${schoolId}/students`;

beforeAll(async () => {
  T = await createTenant(env, await createPlatformAdmin(env), "Roster");
  schoolId = (await call(env.app, T.admin, "POST", `/t/${T.tenantId}/schools`, { name: "Roster School" })).body.school.id;
  const first = await call(env.app, T.admin, "POST", url(), {
    students: [{ givenName: "Amy", familyName: "Lee", dateOfBirth: "2015-01-01", className: "4A", studentNumber: "001" }],
  });
  expect(first.status).toBe(201);
});

describe("school bulk roster", () => {
  const upload = [
    { givenName: "amy", familyName: "LEE", dateOfBirth: "2015-01-01" }, // matches existing (case-insensitive)
    { givenName: "Bo", familyName: "Ng", dateOfBirth: "2015-06-06" },
    { givenName: "Bo", familyName: "Ng", dateOfBirth: "2015-06-06" }, // repeated in this upload
    { givenName: "Cy", familyName: "Ho" },
  ];

  it("dry run reports possible duplicates and creates nothing", async () => {
    const res = await call(env.app, T.admin, "POST", url(), { students: upload, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.wouldCreate).toBe(4);
    expect(res.body.possibleDuplicates).toEqual([
      { row: 0, reason: "on_roster", matchStudentCode: expect.stringMatching(/^S/) },
      { row: 2, reason: "repeated_in_upload", matchRow: 1 },
    ]);
    const roster = await call(env.app, T.admin, "GET", url());
    expect(roster.body.students).toHaveLength(1);
  });

  it("refuses the whole upload until duplicates are confirmed", async () => {
    const res = await call(env.app, T.admin, "POST", url(), { students: upload });
    expect(res.status).toBe(409);
    expect(res.body.error.details.possibleDuplicates).toHaveLength(2);
    expect((await call(env.app, T.admin, "GET", url())).body.students).toHaveLength(1);
  });

  it("creates every row once confirmed, and audits it", async () => {
    const res = await call(env.app, T.admin, "POST", url(), { students: upload, confirmDuplicates: true });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(4);
    const roster = await call(env.app, T.admin, "GET", `${url()}?limit=50`);
    expect(roster.body.students).toHaveLength(5);
    const amy = roster.body.students.find((s: { studentNumber: string | null }) => s.studentNumber === "001");
    expect(amy).toMatchObject({ givenName: "Amy", className: "4A", rosterStatus: "active" });

    const logs = await call(env.app, T.admin, "GET", `/t/${T.tenantId}/audit-logs?action=school.roster_imported`);
    expect(logs.body.auditLogs[0].after).toEqual({ created: 4, confirmedDuplicates: 2 });
  });

  it("rejects oversize uploads and invalid rows", async () => {
    const big = Array.from({ length: 501 }, (_, i) => ({ givenName: `S${i}` }));
    expect((await call(env.app, T.admin, "POST", url(), { students: big })).status).toBe(400);
    const bad = await call(env.app, T.admin, "POST", url(), { students: [{ givenName: "X", dateOfBirth: "31/12/2015" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe("students.0.dateOfBirth");
  });
});
