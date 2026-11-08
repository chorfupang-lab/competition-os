import { describe, expect, it } from "vitest";
import { PASSWORD, call, login, register, unique, useTestEnv } from "./helpers.ts";

const env = useTestEnv();

describe("parent and student accounts", () => {
  it("a parent manages several children, each with a platform Student ID", async () => {
    const parent = await register(env.app, "parent");
    const a = await call(env.app, parent, "POST", "/me/children", { givenName: "Mei", familyName: "Wong", dateOfBirth: "2014-02-02", primaryLocale: "zh-Hant" });
    const b = await call(env.app, parent, "POST", "/me/children", { givenName: "Kit", relationship: "guardian" });
    expect(a.status).toBe(201);
    expect(a.body.child.studentCode).toMatch(/^S[0-9A-HJKMNP-TV-Z]{9}$/);
    expect(a.body.child.studentCode).not.toBe(b.body.child.studentCode);

    const list = await call(env.app, parent, "GET", "/me/children");
    expect(list.body.children).toHaveLength(2);
    expect(list.body.children.find((c: { givenName: string }) => c.givenName === "Kit").relationship).toBe("guardian");
  });

  it("a parent creates a username login for a child; the child signs in and sees their profile", async () => {
    const parent = await register(env.app, "parent");
    const child = await call(env.app, parent, "POST", "/me/children", { givenName: "Nok", dateOfBirth: "2013-09-09" });
    const childId = child.body.child.id;
    const username = unique("nok").toLowerCase();

    const created = await call(env.app, parent, "POST", `/me/children/${childId}/login`, { username, password: PASSWORD });
    expect(created.status).toBe(201);
    const again = await call(env.app, parent, "POST", `/me/children/${childId}/login`, { username: `${username}x`, password: PASSWORD });
    expect(again.status).toBe(409);

    const student = await login(env.app, username);
    const me = await call(env.app, student, "GET", "/me");
    expect(me.body.studentProfile).toMatchObject({ id: childId, givenName: "Nok", hasLogin: true });
    expect(me.body.user.email).toBeNull();
  });

  it("another parent cannot create a login for someone else's child", async () => {
    const parent = await register(env.app, "parent");
    const child = await call(env.app, parent, "POST", "/me/children", { givenName: "Pim" });
    const stranger = await register(env.app, "stranger");
    const res = await call(env.app, stranger, "POST", `/me/children/${child.body.child.id}/login`, { username: unique("pim").toLowerCase(), password: PASSWORD });
    expect(res.status).toBe(404);
  });

  it("usernames and emails share one namespace", async () => {
    const parent = await register(env.app, "parent");
    const child = await call(env.app, parent, "POST", "/me/children", { givenName: "Q" });
    const username = unique("q").toLowerCase();
    expect((await call(env.app, parent, "POST", `/me/children/${child.body.child.id}/login`, { username, password: PASSWORD })).status).toBe(201);
    const child2 = await call(env.app, parent, "POST", "/me/children", { givenName: "R" });
    expect((await call(env.app, parent, "POST", `/me/children/${child2.body.child.id}/login`, { username, password: PASSWORD })).status).toBe(409);
  });
});
