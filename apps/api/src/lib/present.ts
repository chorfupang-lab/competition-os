import type { ConfigIssue } from "@cos/core";
import type { Competition, CompetitionVersion, Tenant } from "@cos/db";

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


export function presentCompetition(c: Competition) {
  return {
    id: c.id,
    tenantId: c.tenant_id,
    slug: c.slug,
    name: c.name,
    nameI18n: c.name_i18n,
    descriptionI18n: c.description_i18n,
    status: c.status,
    visibility: c.visibility,
    feeMode: c.fee_mode,
    currency: c.currency,
    timezone: c.timezone,
    interfaceLocales: c.interface_locales,
    contentLocales: c.content_locales,
    currentVersionId: c.current_version_id,
    firstPublishedAt: c.first_published_at,
    cancelledAt: c.cancelled_at,
    createdAt: c.created_at,
  };
}

export function presentVersionSummary(v: CompetitionVersion) {
  return {
    id: v.id,
    versionNumber: v.version_number,
    status: v.status,
    revision: v.revision,
    changeNote: v.change_note,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    publishedAt: v.published_at,
    publishedBy: v.published_by,
  };
}

export function presentVersion(v: CompetitionVersion, issues: readonly ConfigIssue[]) {
  return { ...presentVersionSummary(v), config: v.config, issues };
}
