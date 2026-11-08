import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { ORIGIN, PASSWORD, call, login, register, testConfig, uniqueEmail, useTestEnv } from "./helpers.ts";

const env = useTestEnv();

describe("authentication", () => {
  it("registers, signs in, and returns the profile", async () => {
    const s = await register(env.app, "alice");
    const me = await call(env.app, s, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: s.email, displayName: "alice", platformRole: null });

    const again = await login(env.app, s.email);
    expect(again.userId).toBe(s.userId);
  });

  it("rejects a duplicate email", async () => {
    const s = await register(env.app, "dup");
    const res = await call(env.app, null, "POST", "/auth/register", { email: s.email, password: PASSWORD, displayName: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("gives one answer for wrong password and unknown account, localized", async () => {
    const s = await register(env.app, "bob");
    for (const identifier of [s.email, uniqueEmail("nobody")]) {
      const res = await env.app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "accept-language": "zh-HK,zh;q=0.9" },
        payload: { identifier, password: "wrong-password!!" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toEqual({ code: "INVALID_CREDENTIALS", message: "登入資料不正確。" });
    }
    const { rows } = await env.owner.query(
      "select count(*)::int as n from audit_logs where action = 'auth.login_failed' and metadata->>'identifier' = $1",
      [s.email],
    );
    expect(rows[0].n).toBe(1);
  });

  it("validates input", async () => {
    const res = await call(env.app, null, "POST", "/auth/register", { email: "not-an-email", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["displayName", "email", "password"]);
  });

  it("logout revokes the session", async () => {
    const s = await register(env.app, "carol");
    expect((await call(env.app, s, "POST", "/auth/logout")).status).toBe(204);
    const me = await call(env.app, s, "GET", "/me");
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects expired sessions and disabled users", async () => {
    const a = await register(env.app, "expired");
    await env.owner.query("update sessions set expires_at = now() - interval '1 second' where user_id = $1", [a.userId]);
    expect((await call(env.app, a, "GET", "/me")).status).toBe(401);

    const b = await register(env.app, "disabled");
    await env.owner.query("update users set status = 'disabled' where id = $1", [b.userId]);
    expect((await call(env.app, b, "GET", "/me")).status).toBe(401);
    const relogin = await call(env.app, null, "POST", "/auth/login", { identifier: b.email, password: PASSWORD });
    expect(relogin.status).toBe(401);
  });

  it("stores only a hash of the session token", async () => {
    const s = await register(env.app, "hash");
    const { rows } = await env.owner.query("select token_hash from sessions where user_id = $1", [s.userId]);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].token_hash).toString("utf8")).not.toContain(s.token);
    expect(rows[0].token_hash.length).toBe(32);
  });
});

describe("cookie sessions and CSRF", () => {
  it("sets an httpOnly cookie and accepts it for reads", async () => {
    const email = uniqueEmail("cookie");
    const res = await env.app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PASSWORD, displayName: "c" } });
    const cookie = res.cookies.find((c) => c.name === "cos_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    const me = await env.app.inject({ method: "GET", url: "/me", cookies: { cos_session: cookie!.value } });
    expect(me.statusCode).toBe(200);
  });

  it("blocks cookie-authenticated changes from other origins", async () => {
    const email = uniqueEmail("csrf");
    const res = await env.app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PASSWORD, displayName: "c" } });
    const cookies = { cos_session: res.cookies.find((c) => c.name === "cos_session")!.value };
    const payload = { displayName: "changed" };

    const evil = await env.app.inject({ method: "PATCH", url: "/me", cookies, headers: { origin: "https://evil.example" }, payload });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe("CSRF_REJECTED");

    const none = await env.app.inject({ method: "PATCH", url: "/me", cookies, payload });
    expect(none.statusCode).toBe(403);

    const ok = await env.app.inject({ method: "PATCH", url: "/me", cookies, headers: { origin: ORIGIN }, payload });
    expect(ok.statusCode).toBe(200);
  });
});

describe("rate limiting", () => {
  it("limits sign-in attempts", async () => {
    const app = await buildApp({
      config: testConfig({ rateLimit: { enabled: true, globalPerMinute: 1000, authPerMinute: 3 } }),
      db: env.db,
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: "POST", url: "/auth/login", payload: { identifier: "x@example.test", password: "wrong-password" } });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await app.close();
    }
  });
});
