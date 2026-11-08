import type { Tenant } from "@cos/db";

export function presentTenant(t: Tenant) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    nameI18n: t.name_i18n,
    status: t.status,
    defaultLocale: t.default_locale,
    timezone: t.timezone,
    countryCode: t.country_code,
    defaultCurrency: t.default_currency,
    createdAt: t.created_at,
  };
}

export function presentAudit(a: {
  id: string;
  occurred_at: Date;
  tenant_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}) {
  return {
    id: a.id,
    occurredAt: a.occurred_at,
    tenantId: a.tenant_id,
    actorUserId: a.actor_user_id,
    action: a.action,
    targetType: a.target_type,
    targetId: a.target_id,
    reason: a.reason,
    before: a.before,
    after: a.after,
    metadata: a.metadata,
  };
}
