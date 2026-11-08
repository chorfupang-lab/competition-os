import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { sql } from "kysely";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AppError, DEFAULT_LOCALE, ERROR_MESSAGES, isLocale, negotiateLocale, type Locale } from "@cos/core";
import { ANONYMOUS, withContext, type DB } from "@cos/db";
import type { Config } from "./config.ts";
import { SESSION_COOKIE, bearerToken } from "./lib/auth.ts";
import { hashToken } from "./lib/crypto.ts";
import { authRoutes } from "./routes/auth.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { competitionRoutes } from "./routes/competitions.ts";
import { contentRoutes } from "./routes/content.ts";
import { meRoutes } from "./routes/me.ts";
import { platformRoutes } from "./routes/platform.ts";
import { tenantRoutes } from "./routes/tenant.ts";

export interface AppDeps {
  config: Config;
  db: DB;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    locale: Locale;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'] }
      : false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  app.decorate("deps", deps);
  app.decorateRequest("auth", null);
  app.decorateRequest("locale", DEFAULT_LOCALE);

  await app.register(cookie);
  if (deps.config.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: true,
      max: deps.config.rateLimit.globalPerMinute,
      timeWindow: "1 minute",
      errorResponseBuilder: () => new AppError("RATE_LIMITED"),
    });
  }

  // Authenticate every request from a session cookie or a Bearer token.
  app.addHook("onRequest", async (request) => {
    request.locale = negotiateLocale(request.headers["accept-language"]) ?? DEFAULT_LOCALE;
    const fromBearer = bearerToken(request);
    const token = fromBearer ?? request.cookies[SESSION_COOKIE] ?? null;
    if (!token) return;
    const session = await withContext(deps.db, ANONYMOUS, async (tx) => {
      const { rows } = await sql<{ session_id: string; user_id: string; platform_role: string | null }>`
        select session_id, user_id, platform_role from app.auth_resolve_session(${hashToken(token)})`.execute(tx);
      return rows[0];
    });
    if (!session) return;
    request.auth = {
      userId: session.user_id,
      sessionId: session.session_id,
      platformAdmin: session.platform_role === "platform_admin",
      viaCookie: !fromBearer,
    };
  });

  // CSRF: cookie-authenticated changes must come from an allowed origin.
  // Bearer-token clients are not exposed to CSRF.
  app.addHook("preHandler", async (request) => {
    if (SAFE_METHODS.has(request.method) || !request.auth?.viaCookie) return;
    if (!originAllowed(request, deps.config.allowedOrigins)) throw new AppError("CSRF_REJECTED");
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    if (appError.status >= 500) request.log.error({ err: error }, "unhandled error");
    const locale = isLocale(request.locale) ? request.locale : DEFAULT_LOCALE;
    void reply.status(appError.status).send({
      error: {
        code: appError.code,
        message: ERROR_MESSAGES[locale][appError.code],
        ...(appError.details !== undefined && { details: appError.details }),
      },
    });
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: { code: "NOT_FOUND", message: ERROR_MESSAGES[request.locale].NOT_FOUND } });
  });

  app.get("/health", async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(meRoutes, { prefix: "/me" });
  await app.register(platformRoutes, { prefix: "/platform" });
  await app.register(tenantRoutes, { prefix: "/t/:tenantId" });
  await app.register(competitionRoutes, { prefix: "/t/:tenantId/competitions" });
  await app.register(contentRoutes, { prefix: "/t/:tenantId/content" });
  await app.register(catalogRoutes, { prefix: "/competitions" });
  return app;
}

function originAllowed(request: FastifyRequest, allowed: string[]): boolean {
  const origin = request.headers.origin;
  if (origin) return allowed.includes(origin);
  // Some browsers omit Origin on same-origin requests; Fetch Metadata covers them.
  return request.headers["sec-fetch-site"] === "same-origin";
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = error as { statusCode?: number; code?: string; validation?: unknown };
  if (e.statusCode === 429) return new AppError("RATE_LIMITED");
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return new AppError("VALIDATION_FAILED");
  // PostgreSQL: unique violation / RLS violation
  if (e.code === "23505") return new AppError("CONFLICT");
  if (e.code === "42501") return new AppError("FORBIDDEN");
  return new AppError("INTERNAL");
}
