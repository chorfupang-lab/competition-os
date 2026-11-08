/**
 * Create or promote a Platform Admin. Runs with the OWNER connection on
 * purpose: the API role cannot grant platform roles, so nobody can escalate
 * through the API. The grant is recorded in the audit log.
 *
 *   DATABASE_URL=... pnpm db:create-platform-admin --email a@b.c --name "Ops" [--password ...]
 *
 * If --password is omitted for a new user, one is generated and printed once.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { hash } from "@node-rs/argon2";
import pg from "pg";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    password: { type: "string" },
    reason: { type: "string" },
  },
});
const url = process.env.DATABASE_URL;
if (!url || !values.email) {
  console.error("Usage: DATABASE_URL=... create-platform-admin --email <email> [--name <name>] [--password <pw>] [--reason <text>]");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("begin");
  const existing = await client.query<{ id: string; platform_role: string | null }>(
    "select id, platform_role from users where email = $1",
    [values.email],
  );
  let userId: string;
  let generated: string | null = null;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await client.query("update users set platform_role = 'platform_admin' where id = $1", [userId]);
  } else {
    const password = values.password ?? (generated = randomBytes(18).toString("base64url"));
    userId = randomUUID();
    await client.query(
      `insert into users (id, email, password_hash, display_name, platform_role)
       values ($1, $2, $3, $4, 'platform_admin')`,
      [userId, values.email, await hash(password), values.name ?? values.email],
    );
  }
  await client.query(
    `insert into audit_logs (action, target_type, target_id, reason, before, after, metadata)
     values ('platform.admin.granted', 'user', $1, $2, $3, '{"platform_role":"platform_admin"}', '{"via":"cli"}')`,
    [
      userId,
      values.reason ?? "Granted with create-platform-admin script",
      JSON.stringify({ platform_role: existing.rows[0]?.platform_role ?? null }),
    ],
  );
  await client.query("commit");
  console.log(`Platform admin ready: ${values.email} (${userId})`);
  if (generated) console.log(`Generated password (shown once): ${generated}`);
} catch (err) {
  await client.query("rollback");
  throw err;
} finally {
  await client.end();
}
