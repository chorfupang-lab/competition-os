import type { TenantRole } from "./roles.ts";

/**
 * Permission catalogue. Permissions for later roadmap stages are declared now
 * so the role mapping is reviewed once; routes for them arrive in later stages.
 *
 * The server is the only authority: the UI may use these to hide controls,
 * but every API route checks them again, and PostgreSQL row-level security
 * enforces tenant isolation underneath.
 */
export const PERMISSIONS = [
  // Tenant & membership
  "tenant.read",
  "tenant.create",
  "tenant.status.manage",
  "members.read",
  "members.manage",
  // Schools & rosters
  "schools.read",
  "schools.manage",
  "school.roster.read",
  "school.roster.manage",
  // Students (tenant-wide visibility)
  "students.read",
  // Governance
  "audit.read",
  // Later stages
  "competitions.manage",
  "registrations.manage",
  "registrations.submit_school",
  "content.read",
  "content.manage",
  "payments.manage",
  "analytics.read",
  "certificates.manage",
  "certificates.approve",
  "notifications.manage",
  "review.submit",
  "review.approve",
  "result.override",
  "integrity.disqualify",
  "ranking.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Judging authority that no other role may hold, including Platform Admin.
 * Hard rule: "Official Result Override = Head Judge only." A Platform Admin
 * who must act can grant themselves Head Judge in a tenant; that grant is
 * audited like any other.
 */
export const HEAD_JUDGE_ONLY: readonly Permission[] = ["result.override", "integrity.disqualify"];

export const TENANT_ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  competition_admin: [
    "tenant.read",
    "members.read",
    "members.manage",
    "schools.read",
    "schools.manage",
    "school.roster.read",
    "school.roster.manage",
    "students.read",
    "audit.read",
    "competitions.manage",
    "registrations.manage",
    "content.read",
    "content.manage",
    "payments.manage",
    "analytics.read",
    "certificates.manage",
    "notifications.manage",
  ],
  school_admin: [
    "tenant.read",
    "school.roster.read",
    "school.roster.manage",
    "registrations.submit_school",
  ],
  judge: ["tenant.read", "content.read", "review.submit", "ranking.read"],
  head_judge: [
    "tenant.read",
    "content.read",
    "review.submit",
    "review.approve",
    "result.override",
    "integrity.disqualify",
    "ranking.read",
    "certificates.approve",
    "analytics.read",
  ],
};

export const PLATFORM_ADMIN_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => !HEAD_JUDGE_ONLY.includes(p),
);

export interface PermissionSubject {
  platformAdmin: boolean;
  tenantRoles: readonly TenantRole[];
}

export function permissionsFor(subject: PermissionSubject): Set<Permission> {
  const result = new Set<Permission>();
  if (subject.platformAdmin) for (const p of PLATFORM_ADMIN_PERMISSIONS) result.add(p);
  for (const role of subject.tenantRoles) for (const p of TENANT_ROLE_PERMISSIONS[role]) result.add(p);
  return result;
}

export function hasPermission(subject: PermissionSubject, permission: Permission): boolean {
  return permissionsFor(subject).has(permission);
}

/**
 * Permissions that make sense for a single competition. A membership scoped
 * to one competition grants only these, and only for that competition.
 * Tenant-wide powers (members, schools, tenant-wide students, audit log)
 * always require an unscoped membership.
 */
export const COMPETITION_SCOPED_PERMISSIONS: readonly Permission[] = [
  "competitions.manage",
  "registrations.manage",
  "payments.manage",
  "analytics.read",
  "certificates.manage",
  "certificates.approve",
  "notifications.manage",
  "review.submit",
  "review.approve",
  "result.override",
  "integrity.disqualify",
  "ranking.read",
];

/** Roles that may be scoped to a single competition. */
export const COMPETITION_SCOPABLE_ROLES: readonly TenantRole[] = ["competition_admin", "judge", "head_judge"];

export function competitionPermissionsFor(subject: PermissionSubject & { competitionRoles: readonly TenantRole[] }): Set<Permission> {
  const result = permissionsFor(subject);
  for (const role of subject.competitionRoles) {
    for (const p of TENANT_ROLE_PERMISSIONS[role]) if (COMPETITION_SCOPED_PERMISSIONS.includes(p)) result.add(p);
  }
  return result;
}
