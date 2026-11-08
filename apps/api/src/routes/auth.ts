import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError } from "@cos/core";
import { ANONYMOUS, setContext, withContext } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { SESSION_COOKIE, requireAuth } from "../lib/auth.ts";
import { hashPassword, newId, newSessionToken, verifyPassword } from "../lib/crypto.ts";
import { parse, zEmail, zLocale, zName, zPassword } from "../lib/validation.ts";

const RegisterBody = z.object({
  email: zEmail,
  password: zPassword,
  displayName: zName,
  locale: zLocale.optional(),
});

const LoginBody = z.object({
  /** Email, or username for student logins. */
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  // Stricter limit for credential endpoints (ignored when rate limiting is disabled).
  const authLimit = { rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: "1 minute" } };

  /** Self sign-up. New accounts are ordinary users; they become parents by adding children. */
  app.post("/register", { config: authLimit }, async (request, reply) => {
    const body = parse(RegisterBody, request.body);
    const passwordHash = await hashPassword(body.password);
    const userId = newId();
    const result = await withContext(db, ANONYMOUS, async (tx) => {
      const { rows } = await sql<{ taken: boolean }>`select app.auth_identifier_taken(${body.email}) as taken`.execute(tx);
      if (rows[0]?.taken) throw new AppError("CONFLICT", { field: "email" });
      await setContext(tx, { ...ANONYMOUS, userId });
      await tx
        .insertInto("users")
        .values({
          id: userId,
          email: body.email,
          password_hash: passwordHash,
          display_name: body.displayName,
          locale: body.locale ?? request.locale,
          platform_role: null,
        })
        .execute();
      await audit(tx, request, { tenantId: null, actorUserId: userId, action: "user.registered", targetType: "user", targetId: userId });
      return startSession(tx, request, userId);
    });
    setSessionCookie(reply, result.token, result.expiresAt, config.cookieSecure);
    return reply.status(201).send({ userId, token: result.token, expiresAt: result.expiresAt });
  });

  app.post("/login", { config: authLimit }, async (request, reply) => {
    const body = parse(LoginBody, request.body);
    const result = await withContext(db, ANONYMOUS, async (tx) => {
      const { rows } = await sql<{ user_id: string; password_hash: string; status: string }>`
        select user_id, password_hash, status from app.auth_find_login(${body.identifier})`.execute(tx);
      const login = rows[0];
      const ok = await verifyPassword(login?.password_hash ?? null, body.password);
      if (!login || !ok || login.status !== "active") {
        await audit(tx, request, {
          tenantId: null,
          actorUserId: null,
          action: "auth.login_failed",
          metadata: { identifier: body.identifier.slice(0, 254) },
        });
        return null;
      }
      await setContext(tx, { ...ANONYMOUS, userId: login.user_id });
      await audit(tx, request, { tenantId: null, actorUserId: login.user_id, action: "auth.login", targetType: "user", targetId: login.user_id });
      return { userId: login.user_id, ...(await startSession(tx, request, login.user_id)) };
    });
    // The failure audit entry is committed above; now report the failure.
    if (!result) throw new AppError("INVALID_CREDENTIALS");
    setSessionCookie(reply, result.token, result.expiresAt, config.cookieSecure);
    return { userId: result.userId, token: result.token, expiresAt: result.expiresAt };
  });

  app.post("/logout", async (request, reply) => {
    const auth = requireAuth(request);
    await withContext(db, { ...ANONYMOUS, userId: auth.userId }, async (tx) => {
      await tx.updateTable("sessions").set({ revoked_at: new Date() }).where("id", "=", auth.sessionId).execute();
      await audit(tx, request, { tenantId: null, actorUserId: auth.userId, action: "auth.logout", targetType: "session", targetId: auth.sessionId });
    });
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  async function startSession(tx: Parameters<Parameters<typeof withContext>[2]>[0], request: FastifyRequest, userId: string) {
    const { token, hash } = newSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
    await tx
      .insertInto("sessions")
      .values({
        user_id: userId,
        token_hash: hash,
        expires_at: expiresAt,
        ip: request.ip,
        user_agent: request.headers["user-agent"]?.slice(0, 500) ?? null,
      })
      .execute();
    return { token, expiresAt: expiresAt.toISOString() };
  }
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: new Date(expiresAt),
  });
}
