import type { FastifyRequest } from "fastify";
import {
  AppError,
  SCHOOL_SCOPED_ROLES,
  competitionPermissionsFor,
  permissionsFor,
  type Permission,
  type TenantRole,
} from "@cos/core";
import { withContext, type DB, type DbContext, type Tenant } from "@cos/db";
import { requireAuth, type AuthInfo } from "./auth.ts";

export interface TenantScope {
  auth: AuthInfo;
  tenant: Tenant;
  /** Roles held tenant-wide (memberships not scoped to a competition). */
  roles: TenantRole[];
  /** Tenant-level permissions. Competition-scoped grants are NOT included; see permissionsInCompetition. */
  permissions: Set<Permission>;
  /** Roles scoped to individual competitions, by competition id. */
  competitionRoles: Map<string, TenantRole[]>;
  /** Schools this user administers here (School Admin). */
  schoolIds: string[];
  /** Sees every student connected to the tenant rather than only own schools. */
  tenantWide: boolean;
  db: DbContext;
}

/**
 * Resolve the caller's authority inside one tenant.
 *
 * Inside tenant routes the RLS context is pinned to that tenant even for
 * Platform Admins (platformAdmin=false at the database), so a tenant-scoped
 * handler cannot read another tenant's rows even if a query forgets a filter.
 */
export async function resolveTenantScope(db: DB, request: FastifyRequest, tenantId: string): Promise<TenantScope> {
  const auth = requireAuth(request);
  const { tenant, memberships } = await withContext(
    db,
    { userId: auth.userId, tenantId: null, platformAdmin: auth.platformAdmin, tenantWide: false, schoolIds: [] },
    async (tx) => ({
      tenant: await tx.selectFrom("tenants").selectAll().where("id", "=", tenantId).executeTakeFirst(),
      memberships: await tx
        .selectFrom("tenant_memberships")
        .select(["role", "school_id", "competition_id"])
        .where("tenant_id", "=", tenantId)
        .where("user_id", "=", auth.userId)
        .where("status", "=", "active")
        .execute(),
    }),
  );
  // Same answer for "does not exist" and "not yours", so tenant IDs cannot be probed.
  if (!tenant || (memberships.length === 0 && !auth.platformAdmin)) throw new AppError("NOT_FOUND");
  if (tenant.status !== "active" && !auth.platformAdmin) throw new AppError("TENANT_SUSPENDED");

  const roles = [...new Set(memberships.filter((m) => !m.competition_id).map((m) => m.role))];
  const competitionRoles = new Map<string, TenantRole[]>();
  for (const m of memberships) {
    if (!m.competition_id) continue;
    competitionRoles.set(m.competition_id, [...(competitionRoles.get(m.competition_id) ?? []), m.role]);
  }
  const permissions = permissionsFor({ platformAdmin: auth.platformAdmin, tenantRoles: roles });
  // Any member may see the tenant itself.
  permissions.add("tenant.read");
  const schoolIds = memberships
    .filter((m) => SCHOOL_SCOPED_ROLES.includes(m.role) && m.school_id)
    .map((m) => m.school_id as string);
  const tenantWide = permissions.has("students.read");
  return {
    auth,
    tenant,
    roles,
    permissions,
    competitionRoles,
    schoolIds,
    tenantWide,
    db: { userId: auth.userId, tenantId: tenant.id, platformAdmin: false, tenantWide, schoolIds },
  };
}

export function requirePermission(scope: TenantScope, permission: Permission): void {
  if (!scope.permissions.has(permission)) throw new AppError("FORBIDDEN");
}

/** Roster access for one school: tenant-wide roster permission, or School Admin of that school. */
export function requireSchoolAccess(scope: TenantScope, schoolId: string, mode: "read" | "manage"): void {
  requirePermission(scope, mode === "read" ? "school.roster.read" : "school.roster.manage");
  if (!scope.tenantWide && !scope.schoolIds.includes(schoolId)) throw new AppError("FORBIDDEN");
}

/** Permissions inside one competition: tenant-level ones plus any grants scoped to it. */
export function permissionsInCompetition(scope: TenantScope, competitionId: string): Set<Permission> {
  return competitionPermissionsFor({
    platformAdmin: scope.auth.platformAdmin,
    tenantRoles: scope.roles,
    competitionRoles: scope.competitionRoles.get(competitionId) ?? [],
  });
}

export function requireCompetitionPermission(scope: TenantScope, competitionId: string, permission: Permission): void {
  if (!permissionsInCompetition(scope, competitionId).has(permission)) throw new AppError("FORBIDDEN");
}
