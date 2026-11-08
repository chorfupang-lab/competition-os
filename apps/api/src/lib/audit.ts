import type { FastifyRequest } from "fastify";
import type { Tx } from "@cos/db";

export interface AuditEntry {
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Append to the audit log inside the caller's transaction, so the entry commits with the change. */
export async function audit(tx: Tx, request: FastifyRequest | null, entry: AuditEntry): Promise<void> {
  const metadata = {
    ...(request && {
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      actingAsPlatformAdmin: request.auth?.platformAdmin ?? false,
    }),
    ...entry.metadata,
  };
  await tx
    .insertInto("audit_logs")
    .values({
      tenant_id: entry.tenantId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      reason: entry.reason ?? null,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      metadata: JSON.stringify(metadata),
    })
    .execute();
}
