import { sql, type Transaction } from "kysely";
import type { DB } from "./client.ts";
import type { Database } from "./types.ts";

/**
 * Who is acting, as seen by PostgreSQL row-level security policies.
 * The API computes this after authenticating and authorizing the request;
 * the database then enforces isolation on every query in the transaction.
 */
export interface DbContext {
  userId: string | null;
  tenantId: string | null;
  platformAdmin: boolean;
  /** May see every student connected to the tenant (not school-scoped). */
  tenantWide: boolean;
  /** Schools the user administers in the current tenant. */
  schoolIds: readonly string[];
}

export const ANONYMOUS: DbContext = {
  userId: null,
  tenantId: null,
  platformAdmin: false,
  tenantWide: false,
  schoolIds: [],
};

export type Tx = Transaction<Database>;

/** Run `fn` in a transaction whose RLS context is `ctx`. Settings are transaction-local. */
export async function withContext<T>(db: DB, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await setContext(tx, ctx);
    return fn(tx);
  });
}

/** Change the RLS context mid-transaction (e.g. right after creating a user). */
export async function setContext(tx: Tx, ctx: DbContext): Promise<void> {
  await sql`select
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true),
      set_config('app.platform_admin', ${ctx.platformAdmin ? "on" : "off"}, true),
      set_config('app.tenant_wide', ${ctx.tenantWide ? "on" : "off"}, true),
      set_config('app.school_ids', ${ctx.schoolIds.join(",")}, true)`.execute(tx);
}
