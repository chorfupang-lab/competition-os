import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError } from "@cos/core";
import { ANONYMOUS, withContext, type DbContext } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { requireAuth, type AuthInfo } from "../lib/auth.ts";
import { hashPassword, newId } from "../lib/crypto.ts";
import { createStudent, presentStudent, studentColumns } from "../lib/students.ts";
import { parse, zDate, zLocale, zName, zPassword, zUsername, zUuid } from "../lib/validation.ts";

const UpdateMeBody = z.object({ displayName: zName.optional(), locale: zLocale.optional() });

const ChildBody = z.object({
  givenName: zName,
  familyName: zName.optional(),
  preferredName: zName.optional(),
  nickname: z.string().trim().min(1).max(60).optional(),
  dateOfBirth: zDate.optional(),
  primaryLocale: zLocale.optional(),
  relationship: z.enum(["parent", "guardian"]).optional(),
});

const ChildLoginBody = z.object({ username: zUsername, password: zPassword });

/** Personal context: the user's own data, their children, their tenants. No tenant is selected. */
function personal(auth: AuthInfo): DbContext {
  return { ...ANONYMOUS, userId: auth.userId };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get("/", async (request) => {
    const auth = requireAuth(request);
    return withContext(db, personal(auth), async (tx) => {
      const user = await tx
        .selectFrom("users")
        .select(["id", "email", "username", "display_name", "locale", "platform_role"])
        .where("id", "=", auth.userId)
        .executeTakeFirstOrThrow();
      const memberships = await tx
        .selectFrom("tenant_memberships as m")
        .innerJoin("tenants as t", "t.id", "m.tenant_id")
        .select(["m.id", "m.role", "m.school_id", "t.id as tenant_id", "t.slug", "t.name", "t.status as tenant_status"])
        .where("m.user_id", "=", auth.userId)
        .where("m.status", "=", "active")
        .orderBy("t.name")
        .execute();
      const children = await tx
        .selectFrom("parent_children as pc")
        .innerJoin("students", "students.id", "pc.student_id")
        .select([...studentColumns, "pc.relationship"])
        .where("pc.parent_user_id", "=", auth.userId)
        .orderBy("students.given_name")
        .execute();
      const studentProfile = await tx
        .selectFrom("students")
        .select(studentColumns)
        .where("students.user_id", "=", auth.userId)
        .executeTakeFirst();
      return {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          displayName: user.display_name,
          locale: user.locale,
          platformRole: user.platform_role,
        },
        memberships: memberships.map((m) => ({
          id: m.id,
          role: m.role,
          schoolId: m.school_id,
          tenant: { id: m.tenant_id, slug: m.slug, name: m.name, status: m.tenant_status },
        })),
        children: children.map((c) => ({ ...presentStudent(c), relationship: c.relationship })),
        studentProfile: studentProfile ? presentStudent(studentProfile) : null,
      };
    });
  });

  app.patch("/", async (request) => {
    const auth = requireAuth(request);
    const body = parse(UpdateMeBody, request.body);
    await withContext(db, personal(auth), async (tx) => {
      const before = await tx.selectFrom("users").select(["display_name", "locale"]).where("id", "=", auth.userId).executeTakeFirstOrThrow();
      const changes = {
        ...(body.displayName !== undefined && { display_name: body.displayName }),
        ...(body.locale !== undefined && { locale: body.locale }),
      };
      if (Object.keys(changes).length === 0) return;
      await tx.updateTable("users").set(changes).where("id", "=", auth.userId).execute();
      await audit(tx, request, { tenantId: null, actorUserId: auth.userId, action: "user.profile_updated", targetType: "user", targetId: auth.userId, before, after: changes });
    });
    return { ok: true };
  });

  app.get("/children", async (request) => {
    const auth = requireAuth(request);
    const rows = await withContext(db, personal(auth), (tx) =>
      tx
        .selectFrom("parent_children as pc")
        .innerJoin("students", "students.id", "pc.student_id")
        .select([...studentColumns, "pc.relationship"])
        .where("pc.parent_user_id", "=", auth.userId)
        .orderBy("students.given_name")
        .execute(),
    );
    return { children: rows.map((c) => ({ ...presentStudent(c), relationship: c.relationship })) };
  });

  /** A parent adds a child. This creates a new platform Student ID. */
  app.post("/children", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parse(ChildBody, request.body);
    const child = await withContext(db, personal(auth), async (tx) => {
      const student = await createStudent(tx, auth.userId, body);
      await tx
        .insertInto("parent_children")
        .values({ parent_user_id: auth.userId, student_id: student.id, relationship: body.relationship ?? "parent" })
        .execute();
      await audit(tx, request, { tenantId: null, actorUserId: auth.userId, action: "student.created_by_parent", targetType: "student", targetId: student.id });
      return tx.selectFrom("students").select(studentColumns).where("students.id", "=", student.id).executeTakeFirstOrThrow();
    });
    return reply.status(201).send({ child: presentStudent(child) });
  });

  app.get("/children/:studentId", async (request) => {
    const auth = requireAuth(request);
    const { studentId } = parse(z.object({ studentId: zUuid }), request.params);
    const child = await withContext(db, personal(auth), (tx) =>
      tx
        .selectFrom("parent_children as pc")
        .innerJoin("students", "students.id", "pc.student_id")
        .select([...studentColumns, "pc.relationship"])
        .where("pc.parent_user_id", "=", auth.userId)
        .where("pc.student_id", "=", studentId)
        .executeTakeFirst(),
    );
    if (!child) throw new AppError("NOT_FOUND");
    return { child: { ...presentStudent(child), relationship: child.relationship } };
  });

  /** A parent creates a username/password login for their child (children often have no email). */
  app.post("/children/:studentId/login", async (request, reply) => {
    const auth = requireAuth(request);
    const { studentId } = parse(z.object({ studentId: zUuid }), request.params);
    const body = parse(ChildLoginBody, request.body);
    const passwordHash = await hashPassword(body.password);
    const result = await withContext(db, personal(auth), async (tx) => {
      const child = await tx
        .selectFrom("parent_children as pc")
        .innerJoin("students", "students.id", "pc.student_id")
        .select(["students.id", "students.user_id", "students.given_name", "students.preferred_name"])
        .where("pc.parent_user_id", "=", auth.userId)
        .where("pc.student_id", "=", studentId)
        .executeTakeFirst();
      if (!child) throw new AppError("NOT_FOUND");
      if (child.user_id) throw new AppError("CONFLICT", { reason: "child already has a login" });
      const { rows } = await sql<{ taken: boolean }>`select app.auth_identifier_taken(${body.username}) as taken`.execute(tx);
      if (rows[0]?.taken) throw new AppError("CONFLICT", { field: "username" });
      const userId = newId();
      await tx
        .insertInto("users")
        .values({
          id: userId,
          username: body.username,
          email: null,
          password_hash: passwordHash,
          display_name: child.preferred_name ?? child.given_name ?? body.username,
          platform_role: null,
        })
        .execute();
      await tx.updateTable("students").set({ user_id: userId }).where("id", "=", studentId).execute();
      await audit(tx, request, { tenantId: null, actorUserId: auth.userId, action: "student.login_created", targetType: "student", targetId: studentId, after: { username: body.username } });
      return { userId };
    });
    return reply.status(201).send({ userId: result.userId, username: body.username });
  });
}
