import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, inject } from "vitest";
import { createDb, type DB } from "@cos/db";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { hashPassword } from "../src/lib/crypto.ts";

export const ORIGIN = "http://app.test";
export const PASSWORD = "correct-horse-battery";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    appDatabaseUrl: inject("appUrl"),
    port: 0,
    nodeEnv: "test",
    allowedOrigins: [ORIGIN],
    sessionTtlHours: 24,
    cookieSecure: false,
    rateLimit: { enabled: false, globalPerMinute: 1000, authPerMinute: 1000 },
    logger: false,
    ...overrides,
  };
}

export interface TestEnv {
  app: FastifyInstance;
  db: DB;
  /** Owner connection: bypasses RLS. Used only to arrange fixtures and to inspect. */
  owner: pg.Pool;
}

/** One app per test file, with its own pools; closed after the file. */
export function useTestEnv(overrides: Partial<Config> = {}): TestEnv {
  const env = {} as TestEnv;
  beforeAll(async () => {
    env.db = createDb(inject("appUrl"), { max: 5 });
    env.owner = new pg.Pool({ connectionString: inject("ownerUrl"), max: 2 });
    env.app = await buildApp({ config: testConfig(overrides), db: env.db });
  });
  afterAll(async () => {
    await env.app?.close();
    await env.db?.destroy();
    await env.owner?.end();
  });
  return env;
}

export const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
export const uniqueEmail = (prefix = "user") => `${unique(prefix)}@example.test`;

export interface Session {
  userId: string;
  token: string;
  email: string;
  headers: Record<string, string>;
}

export async function register(app: FastifyInstance, name = "user"): Promise<Session> {
  const email = uniqueEmail(name);
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: PASSWORD, displayName: name },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const { userId, token } = res.json();
  return { userId, token, email, headers: { authorization: `Bearer ${token}` } };
}

export async function login(app: FastifyInstance, identifier: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { identifier, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const { userId, token } = res.json();
  return { userId, token, email: identifier, headers: { authorization: `Bearer ${token}` } };
}

/** Same path as the create-platform-admin CLI: owner connection, never the API. */
export async function createPlatformAdmin(env: TestEnv): Promise<Session> {
  const email = uniqueEmail("platform");
  await env.owner.query(
    `insert into users (id, email, password_hash, display_name, platform_role) values ($1, $2, $3, 'Platform', 'platform_admin')`,
    [randomUUID(), email, await hashPassword(PASSWORD)],
  );
  return login(env.app, email);
}

/** Request helper: JSON in, parsed JSON out. */
export async function call(
  app: FastifyInstance,
  session: Session | null,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: session?.headers ?? {},
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

export interface TenantFixture {
  tenantId: string;
  admin: Session;
}

export async function createTenant(env: TestEnv, platformAdmin: Session, name = "Tenant"): Promise<TenantFixture> {
  const admin = await register(env.app, `${name}-admin`);
  const res = await call(env.app, platformAdmin, "POST", "/platform/tenants", {
    slug: unique(name.toLowerCase()),
    name,
    defaultLocale: "zh-Hant",
    countryCode: "HK",
    defaultCurrency: "HKD",
    initialAdminEmail: admin.email,
  });
  if (res.status !== 201) throw new Error(`createTenant failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { tenantId: res.body.tenant.id, admin };
}
