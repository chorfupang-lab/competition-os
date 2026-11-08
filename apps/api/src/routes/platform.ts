import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError } from "@cos/core";
import { ANONYMOUS, withContext, type DbContext } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { requirePlatformAdmin, type AuthInfo } from "../lib/auth.ts";
import { presentAudit, presentTenant } from "../lib/present.ts";
import { parse, zEmail, zI18n, zLocale, zReason, zUuid } from "../lib/validation.ts";

const CreateTenantBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1).max(200),
  nameI18n: zI18n.optional(),
  defaultLocale: zLocale.optional(),
  timezone: z.string().min(1).max(64).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  /** Existing user to make the tenant's first Competition Admin. */
  initialAdminEmail: zEmail.optional(),
});

const StatusBody = z.object({ status: z.enum(["active", "suspended", "disabled"]), reason: zReason });

/** Platform context: RLS bypass for platform admins only. Every change here is audited. */
function platform(auth: AuthInfo): DbContext {
  return { ...ANONYMOUS, userId: auth.userId, platformAdmin: true };
}

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get("/tenants", async (request) => {
    const auth = requirePlatformAdmin(request);
    const tenants = await withContext(db, platform(auth), (tx) => tx.selectFrom("tenants").selectAll().orderBy("name").execute());
    return { tenants: tenants.map(presentTenant) };
  });

  app.post("/tenants", async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const body = parse(CreateTenantBody, request.body);
    const tenant = await withContext(db, platform(auth), async (tx) => {
      const tenant = await tx
        .insertInto("tenants")
        .values({
          slug: body.slug,
          name: body.name,
          name_i18n: JSON.stringify(body.nameI18n ?? {}),
          ...(body.defaultLocale && { default_locale: body.defaultLocale }),
          ...(body.timezone && { timezone: body.timezone }),
          country_code: body.countryCode ?? null,
          default_currency: body.defaultCurrency ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { tenantId: tenant.id, actorUserId: auth.userId, action: "tenant.created", targetType: "tenant", targetId: tenant.id, after: presentTenant(tenant) });
      if (body.initialAdminEmail) {
        const { rows } = await sql<{ id: string | null }>`select app.find_user_id_by_email(${body.initialAdminEmail}) as id`.execute(tx);
        const userId = rows[0]?.id;
        if (!userId) throw new AppError("NOT_FOUND", { field: "initialAdminEmail" });
        const membership = await tx
          .insertInto("tenant_memberships")
          .values({ tenant_id: tenant.id, user_id: userId, role: "competition_admin", school_id: null, created_by: auth.userId, revoked_at: null })
          .returning(["id"])
          .executeTakeFirstOrThrow();
        await audit(tx, request, { tenantId: tenant.id, actorUserId: auth.userId, action: "membership.granted", targetType: "membership", targetId: membership.id, after: { userId, role: "competition_admin" } });
      }
      return tenant;
    });
    return reply.status(201).send({ tenant: presentTenant(tenant) });
  });

  /** Suspend, disable or reactivate a tenant. A reason is mandatory. */
  app.post("/tenants/:tenantId/status", async (request) => {
    const auth = requirePlatformAdmin(request);
    const { tenantId } = parse(z.object({ tenantId: zUuid }), request.params);
    const body = parse(StatusBody, request.body);
    const tenant = await withContext(db, platform(auth), async (tx) => {
      const before = await tx.selectFrom("tenants").select(["status"]).where("id", "=", tenantId).forUpdate().executeTakeFirst();
      if (!before) throw new AppError("NOT_FOUND");
      const tenant = await tx.updateTable("tenants").set({ status: body.status }).where("id", "=", tenantId).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { tenantId, actorUserId: auth.userId, action: "tenant.status_changed", targetType: "tenant", targetId: tenantId, reason: body.reason, before, after: { status: body.status } });
      return tenant;
    });
    return { tenant: presentTenant(tenant) };
  });

  app.get("/audit-logs", async (request) => {
    const auth = requirePlatformAdmin(request);
    const q = parse(
      z.object({
        tenantId: zUuid.optional(),
        action: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.iso.datetime({ offset: true }).optional(),
      }),
      request.query,
    );
    const logs = await withContext(db, platform(auth), (tx) => {
      let query = tx.selectFrom("audit_logs").selectAll().orderBy("occurred_at", "desc").limit(q.limit);
      if (q.tenantId) query = query.where("tenant_id", "=", q.tenantId);
      if (q.action) query = query.where("action", "=", q.action);
      if (q.before) query = query.where("occurred_at", "<", new Date(q.before));
      return query.execute();
    });
    return { auditLogs: logs.map(presentAudit) };
  });

  /** Connect the tenant's merchant account at a payment provider (the tenant is the merchant). */
  app.post("/tenants/:tenantId/payment-accounts", async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const { tenantId } = parse(z.object({ tenantId: zUuid }), request.params);
    const body = parse(z.object({ provider: z.enum(["airwallex", "test"]), externalAccountId: z.string().trim().min(1).max(200) }), request.body);
    const account = await withContext(db, platform(auth), async (tx) => {
      const t = await tx.selectFrom("tenants").select("id").where("id", "=", tenantId).executeTakeFirst();
      if (!t) throw new AppError("NOT_FOUND");
      const previous = await tx.updateTable("tenant_payment_accounts").set({ status: "disabled" }).where("tenant_id", "=", tenantId).where("status", "=", "active").returning(["id", "provider", "external_account_id"]).execute();
      const a = await tx.insertInto("tenant_payment_accounts").values({ tenant_id: tenantId, provider: body.provider, external_account_id: body.externalAccountId, created_by: auth.userId }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { tenantId, actorUserId: auth.userId, action: "payment_account.connected", targetType: "tenant", targetId: tenantId, before: previous, after: body });
      return a;
    });
    return reply.status(201).send({ account: { id: account.id, provider: account.provider, externalAccountId: account.external_account_id, status: account.status } });
  });

  /** The platform's fee on each order, in basis points (until SaaS plans arrive in stage 9). */
  app.post("/tenants/:tenantId/platform-fee", async (request) => {
    const auth = requirePlatformAdmin(request);
    const { tenantId } = parse(z.object({ tenantId: zUuid }), request.params);
    const body = parse(z.object({ bps: z.number().int().min(0).max(10_000), reason: zReason }), request.body);
    await withContext(db, platform(auth), async (tx) => {
      const before = await tx.selectFrom("tenants").select("platform_fee_bps").where("id", "=", tenantId).executeTakeFirst();
      if (!before) throw new AppError("NOT_FOUND");
      await tx.updateTable("tenants").set({ platform_fee_bps: body.bps }).where("id", "=", tenantId).execute();
      await audit(tx, request, { tenantId, actorUserId: auth.userId, action: "tenant.platform_fee_changed", targetType: "tenant", targetId: tenantId, reason: body.reason, before: { bps: before.platform_fee_bps }, after: { bps: body.bps } });
    });
    return { ok: true };
  });
}
