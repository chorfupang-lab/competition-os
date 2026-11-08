import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Apply pending SQL migrations in filename order, each in its own
 * transaction. Applied files are checksummed; editing one afterwards is an
 * error (write a new migration instead).
 */
export async function migrate(connectionString: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727001)");
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`Migration ${file} changed after it was applied`);
        continue;
      }
      log(`applying ${file}`);
      await client.query("begin");
      try {
        await client.query(body);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file, checksum]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
      applied.push(file);
    }
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => {});
    await client.end();
  }
  return applied;
}
