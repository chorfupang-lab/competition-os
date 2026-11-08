import { sql } from "kysely";
import { OFFLINE_SYNC_GRACE_MS } from "@cos/core";
import { SYSTEM_PLATFORM, systemTenantContext, withContext, type Attempt, type DB } from "@cos/db";
import { releaseAndPromote } from "./registration.ts";
import { closeIfExpired } from "./runtime.ts";

export interface MaintenanceReport {
  attemptsSubmitted: number;
  competitionsSwept: number;
}

/**
 * Periodic housekeeping, safe to run from several workers at once (each item
 * is locked while processed):
 *   - submit attempts whose time ran out (participant gone or offline)
 *   - release lapsed seat holds and promote waitlists
 */
export async function runMaintenance(db: DB, now = new Date()): Promise<MaintenanceReport> {
  const due = await withContext(db, SYSTEM_PLATFORM, async (tx) => {
    const { rows } = await sql<{ id: string; tenant_id: string }>`select * from app.due_attempts(${Math.ceil(OFFLINE_SYNC_GRACE_MS / 1000)}, 500)`.execute(tx);
    return rows;
  });
  let attemptsSubmitted = 0;
  for (const d of due) {
    const done = await withContext(db, systemTenantContext(d.tenant_id), async (tx) => {
      const a = await tx.selectFrom("attempts").selectAll().where("id", "=", d.id).forUpdate().skipLocked().executeTakeFirst();
      if (!a) return false;
      const after = await closeIfExpired(tx, null, a as Attempt, now);
      return after.status === "submitted" && a.status !== "submitted";
    });
    if (done) attemptsSubmitted++;
  }
  const holds = await withContext(db, SYSTEM_PLATFORM, async (tx) => {
    const { rows } = await sql<{ competition_id: string; tenant_id: string }>`select * from app.competitions_with_expired_holds(200)`.execute(tx);
    return rows;
  });
  for (const h of holds) await releaseAndPromote(db, null, h.competition_id, h.tenant_id, now);
  return { attemptsSubmitted, competitionsSwept: holds.length };
}
