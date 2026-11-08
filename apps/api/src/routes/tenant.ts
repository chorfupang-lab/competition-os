import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError } from "@cos/core";
import { withContext } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { presentAudit, presentTenant } from "../lib/present.ts";
import { createStudent, presentStudent, studentColumns } from "../lib/students.ts";
import { requirePermission, requireSchoolAccess, resolveTenantScope } from "../lib/tenant-scope.ts";
import { parse, zDate, zEmail, zI18n, zLocale, zName, zReason, zTenantRole, zUuid } from "../lib/validation.ts";

const TenantParams = z.object({ tenantId: zUuid });

const GrantBody = z
  .object({ email: zEmail, role: zTenantRole, schoolId: zUuid.optional() })
  .refine((b) => (b.role === "school_admin") === (b.schoolId !== undefined), {
    message: "schoolId is required for school_admin and not allowed for other roles",
    path: ["schoolId"],
  });

const SchoolBody = z.object({
  name: z.string().trim().min(1).max(300),
  nameI18n: zI18n.optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  externalRef: z.string().max(100).optional(),
});

const RosterStudent = z.object({
  givenName: zName,
  familyName: zName.optional(),
  preferredName: zName.optional(),
  nickname: z.string().trim().min(1).max(60).optional(),
  dateOfBirth: zDate.optional(),
  primaryLocale: zLocale.optional(),
  grade: z.string().trim().max(40).optional(),
  className: z.string().trim().max(40).optional(),
  studentNumber: z.string().trim().max(60).optional(),
});

const RosterBody = z.object({
  students: z.array(RosterStudent).min(1).max(500),
  /** Validate and report possible duplicates without creating anything. */
  dryRun: z.boolean().default(false),
  /** Create rows even where a possible duplicate was found (after the admin has reviewed them). */
  confirmDuplicates: z.boolean().default(false),
});

const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const scopeOf = (request: FastifyRequest) => resolveTenantScope(db, request, parse(TenantParams, request.params).tenantId);

  app.get("/", async (request) => {
    const scope = await scopeOf(request);
    return {
      tenant: presentTenant(scope.tenant),
      roles: scope.roles,
      permissions: [...scope.permissions].sort(),
      schoolIds: scope.schoolIds,
    };
  });

  // ---------------------------------------------------------------- members

  app.get("/members", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "members.read");
    const rows = await withContext(db, scope.db, (tx) =>
      tx
        .selectFrom("tenant_memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select(["m.id", "m.role", "m.school_id", "m.status", "m.created_at", "u.id as user_id", "u.email", "u.display_name"])
        .where("m.tenant_id", "=", scope.tenant.id)
        .orderBy("m.created_at")
        .execute(),
    );
    return {
      members: rows.map((m) => ({
        id: m.id,
        role: m.role,
        schoolId: m.school_id,
        status: m.status,
        createdAt: m.created_at,
        user: { id: m.user_id, email: m.email, displayName: m.display_name },
      })),
    };
  });

  /** Grant a tenant role to an existing user. (Email invitations arrive with notifications.) */
  app.post("/members", async (request, reply) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "members.manage");
    const body = parse(GrantBody, request.body);
    const membership = await withContext(db, scope.db, async (tx) => {
      const { rows } = await sql<{ id: string | null }>`select app.find_user_id_by_email(${body.email}) as id`.execute(tx);
      const userId = rows[0]?.id;
      if (!userId) throw new AppError("NOT_FOUND", { field: "email" });
      if (body.schoolId) {
        const school = await tx.selectFrom("schools").select("id").where("id", "=", body.schoolId).executeTakeFirst();
        if (!school) throw new AppError("NOT_FOUND", { field: "schoolId" });
      }
      const m = await tx
        .insertInto("tenant_memberships")
        .values({
          tenant_id: scope.tenant.id,
          user_id: userId,
          role: body.role,
          school_id: body.schoolId ?? null,
          created_by: scope.auth.userId,
          revoked_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "membership.granted",
        targetType: "membership",
        targetId: m.id,
        after: { userId, role: m.role, schoolId: m.school_id },
      });
      return m;
    });
    return reply.status(201).send({ membership: { id: membership.id, userId: membership.user_id, role: membership.role, schoolId: membership.school_id } });
  });

  app.post("/members/:membershipId/revoke", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "members.manage");
    const { membershipId } = parse(z.object({ membershipId: zUuid }), request.params);
    const { reason } = parse(z.object({ reason: zReason }), request.body);
    await withContext(db, scope.db, async (tx) => {
      const m = await tx
        .updateTable("tenant_memberships")
        .set({ status: "revoked", revoked_at: new Date() })
        .where("id", "=", membershipId)
        .where("tenant_id", "=", scope.tenant.id)
        .where("status", "=", "active")
        .returning(["id", "user_id", "role", "school_id"])
        .executeTakeFirst();
      if (!m) throw new AppError("NOT_FOUND");
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "membership.revoked",
        targetType: "membership",
        targetId: m.id,
        reason,
        before: { userId: m.user_id, role: m.role, schoolId: m.school_id, status: "active" },
        after: { status: "revoked" },
      });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- schools

  app.get("/schools", async (request) => {
    const scope = await scopeOf(request);
    if (!scope.permissions.has("schools.read") && scope.schoolIds.length === 0) throw new AppError("FORBIDDEN");
    const rows = await withContext(db, scope.db, (tx) => {
      let q = tx.selectFrom("schools").selectAll().where("tenant_id", "=", scope.tenant.id).orderBy("name");
      // School Admins see only their own schools.
      if (!scope.permissions.has("schools.read")) q = q.where("id", "in", scope.schoolIds);
      return q.execute();
    });
    return {
      schools: rows.map((s) => ({ id: s.id, name: s.name, nameI18n: s.name_i18n, countryCode: s.country_code, externalRef: s.external_ref, status: s.status })),
    };
  });

  app.post("/schools", async (request, reply) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "schools.manage");
    const body = parse(SchoolBody, request.body);
    const school = await withContext(db, scope.db, async (tx) => {
      const s = await tx
        .insertInto("schools")
        .values({
          tenant_id: scope.tenant.id,
          name: body.name,
          name_i18n: JSON.stringify(body.nameI18n ?? {}),
          country_code: body.countryCode ?? null,
          external_ref: body.externalRef ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { tenantId: scope.tenant.id, actorUserId: scope.auth.userId, action: "school.created", targetType: "school", targetId: s.id, after: { name: s.name } });
      return s;
    });
    return reply.status(201).send({ school: { id: school.id, name: school.name } });
  });

  // ---------------------------------------------------------------- school rosters

  app.get("/schools/:schoolId/students", async (request) => {
    const scope = await scopeOf(request);
    const { schoolId } = parse(z.object({ schoolId: zUuid }), request.params);
    requireSchoolAccess(scope, schoolId, "read");
    const page = parse(Paging, request.query);
    const rows = await withContext(db, scope.db, (tx) =>
      tx
        .selectFrom("school_students as ss")
        .innerJoin("students", "students.id", "ss.student_id")
        .select([...studentColumns, "ss.grade", "ss.class_name", "ss.student_number", "ss.status as roster_status"])
        .where("ss.tenant_id", "=", scope.tenant.id)
        .where("ss.school_id", "=", schoolId)
        .orderBy("students.family_name")
        .orderBy("students.given_name")
        .limit(page.limit)
        .offset(page.offset)
        .execute(),
    );
    return {
      students: rows.map((r) => ({
        ...presentStudent(r),
        grade: r.grade,
        className: r.class_name,
        studentNumber: r.student_number,
        rosterStatus: r.roster_status,
      })),
    };
  });

  /**
   * School bulk roster upload. Creates platform Student IDs and links them to
   * the school. Possible duplicates (same name + date of birth already on this
   * roster or repeated in the upload) are never silently dropped: the request
   * is refused with the list until the admin re-submits with confirmDuplicates.
   */
  app.post("/schools/:schoolId/students", async (request, reply) => {
    const scope = await scopeOf(request);
    const { schoolId } = parse(z.object({ schoolId: zUuid }), request.params);
    requireSchoolAccess(scope, schoolId, "manage");
    const body = parse(RosterBody, request.body);

    const result = await withContext(db, scope.db, async (tx) => {
      const school = await tx.selectFrom("schools").select(["id", "status"]).where("id", "=", schoolId).executeTakeFirst();
      if (!school) throw new AppError("NOT_FOUND");

      const existing = await tx
        .selectFrom("school_students as ss")
        .innerJoin("students", "students.id", "ss.student_id")
        .select(["students.id", "students.student_code", "students.given_name", "students.family_name", "students.date_of_birth"])
        .where("ss.school_id", "=", schoolId)
        .execute();
      const key = (g: string | null, f: string | null | undefined, d: string | null | undefined) =>
        `${(g ?? "").trim().toLowerCase()}|${(f ?? "").trim().toLowerCase()}|${d ?? ""}`;
      const existingByKey = new Map(existing.map((e) => [key(e.given_name, e.family_name, e.date_of_birth), e]));
      const seen = new Map<string, number>();
      const possibleDuplicates: Array<{ row: number; reason: "on_roster" | "repeated_in_upload"; matchStudentCode?: string; matchRow?: number }> = [];
      body.students.forEach((s, row) => {
        const k = key(s.givenName, s.familyName, s.dateOfBirth);
        const match = existingByKey.get(k);
        if (match) possibleDuplicates.push({ row, reason: "on_roster", matchStudentCode: match.student_code });
        const prior = seen.get(k);
        if (prior !== undefined) possibleDuplicates.push({ row, reason: "repeated_in_upload", matchRow: prior });
        else seen.set(k, row);
      });

      if (body.dryRun) return { status: 200, payload: { dryRun: true, wouldCreate: body.students.length, possibleDuplicates } };
      if (possibleDuplicates.length > 0 && !body.confirmDuplicates) {
        throw new AppError("CONFLICT", { possibleDuplicates });
      }

      const created: Array<{ row: number; studentId: string; studentCode: string }> = [];
      for (const [row, s] of body.students.entries()) {
        const student = await createStudent(tx, scope.auth.userId, s);
        await tx
          .insertInto("tenant_students")
          .values({ tenant_id: scope.tenant.id, student_id: student.id, source: "school_roster" })
          .onConflict((oc) => oc.columns(["tenant_id", "student_id"]).doNothing())
          .execute();
        await tx
          .insertInto("school_students")
          .values({
            tenant_id: scope.tenant.id,
            school_id: schoolId,
            student_id: student.id,
            grade: s.grade ?? null,
            class_name: s.className ?? null,
            student_number: s.studentNumber ?? null,
          })
          .execute();
        created.push({ row, studentId: student.id, studentCode: student.studentCode });
      }
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "school.roster_imported",
        targetType: "school",
        targetId: schoolId,
        after: { created: created.length, confirmedDuplicates: body.confirmDuplicates ? possibleDuplicates.length : 0 },
      });
      return { status: 201, payload: { created, possibleDuplicates } };
    });
    return reply.status(result.status).send(result.payload);
  });

  // ---------------------------------------------------------------- students

  /** Tenant-wide student list: only students connected to this tenant. */
  app.get("/students", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "students.read");
    const page = parse(Paging, request.query);
    const rows = await withContext(db, scope.db, (tx) =>
      tx
        .selectFrom("tenant_students as ts")
        .innerJoin("students", "students.id", "ts.student_id")
        .select(studentColumns)
        .where("ts.tenant_id", "=", scope.tenant.id)
        .orderBy("students.family_name")
        .orderBy("students.given_name")
        .limit(page.limit)
        .offset(page.offset)
        .execute(),
    );
    return { students: rows.map(presentStudent) };
  });

  app.get("/students/:studentId", async (request) => {
    const scope = await scopeOf(request);
    const { studentId } = parse(z.object({ studentId: zUuid }), request.params);
    if (!scope.tenantWide && scope.schoolIds.length === 0) throw new AppError("FORBIDDEN");
    const student = await withContext(db, scope.db, async (tx) => {
      // Must be connected to THIS tenant; RLS additionally limits School Admins to their schools.
      const s = await tx
        .selectFrom("students")
        .innerJoin("tenant_students as ts", (j) => j.onRef("ts.student_id", "=", "students.id").on("ts.tenant_id", "=", scope.tenant.id))
        .select(studentColumns)
        .where("students.id", "=", studentId)
        .executeTakeFirst();
      if (!s) return null;
      const schools = await tx
        .selectFrom("school_students as ss")
        .innerJoin("schools", "schools.id", "ss.school_id")
        .select(["schools.id", "schools.name", "ss.grade", "ss.class_name", "ss.status"])
        .where("ss.student_id", "=", studentId)
        .where("ss.tenant_id", "=", scope.tenant.id)
        .execute();
      return { ...presentStudent(s), schools: schools.map((x) => ({ id: x.id, name: x.name, grade: x.grade, className: x.class_name, status: x.status })) };
    });
    if (!student) throw new AppError("NOT_FOUND");
    return { student };
  });

  // ---------------------------------------------------------------- audit

  app.get("/audit-logs", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "audit.read");
    const q = parse(Paging.extend({ action: z.string().max(100).optional() }), request.query);
    const rows = await withContext(db, scope.db, (tx) => {
      let query = tx
        .selectFrom("audit_logs")
        .selectAll()
        .where("tenant_id", "=", scope.tenant.id)
        .orderBy("occurred_at", "desc")
        .limit(q.limit)
        .offset(q.offset);
      if (q.action) query = query.where("action", "=", q.action);
      return query.execute();
    });
    return { auditLogs: rows.map(presentAudit) };
  });
}
