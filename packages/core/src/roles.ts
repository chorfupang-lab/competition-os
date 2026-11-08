/**
 * Roles.
 *
 * - Platform roles are held by a user across the whole platform.
 * - Tenant roles are granted per tenant through a membership.
 * - Parent and Student are relationship roles: a user is a parent because
 *   they have linked children, and a student because a student profile is
 *   linked to their login. Access for these is resource-based (own children,
 *   own profile), not permission-string-based.
 */
export const PLATFORM_ROLES = ["platform_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const TENANT_ROLES = ["competition_admin", "school_admin", "judge", "head_judge"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const RELATIONSHIP_ROLES = ["parent", "student"] as const;
export type RelationshipRole = (typeof RELATIONSHIP_ROLES)[number];

export type Role = PlatformRole | TenantRole | RelationshipRole;

export function isTenantRole(value: string): value is TenantRole {
  return (TENANT_ROLES as readonly string[]).includes(value);
}

/** Tenant roles that are limited to specific schools rather than the whole tenant. */
export const SCHOOL_SCOPED_ROLES: readonly TenantRole[] = ["school_admin"];
