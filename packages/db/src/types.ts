import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/**
 * Typed view of the schema in ../migrations. The SQL migrations are the
 * source of truth (they carry row-level security policies that ORMs model
 * poorly); keep this file in step when a migration changes a table.
 */

/** Timestamp with a database default: optional on insert. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string | undefined, string>;

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  name_i18n: Json;
  status: Generated<"active" | "suspended" | "disabled">;
  default_locale: Generated<string>;
  timezone: Generated<string>;
  country_code: string | null;
  default_currency: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UsersTable {
  id: string;
  email: string | null;
  username: string | null;
  email_verified_at: NullableTimestamp;
  password_hash: string;
  display_name: string;
  locale: Generated<string>;
  status: Generated<"active" | "disabled">;
  platform_role: "platform_admin" | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Buffer;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: NullableTimestamp;
  ip: string | null;
  user_agent: string | null;
}

export interface SchoolsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  name_i18n: Json;
  country_code: string | null;
  external_ref: string | null;
  status: Generated<"active" | "archived">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TenantMembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role: "competition_admin" | "school_admin" | "judge" | "head_judge";
  school_id: string | null;
  competition_id: Generated<string | null>;
  status: Generated<"active" | "revoked">;
  created_by: string | null;
  created_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface StudentsTable {
  id: string;
  student_code: string;
  user_id: string | null;
  given_name: string | null;
  family_name: string | null;
  preferred_name: string | null;
  nickname: string | null;
  date_of_birth: ColumnType<string | null, string | null | undefined, string | null>;
  primary_locale: string | null;
  created_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  anonymized_at: NullableTimestamp;
}

export interface ParentChildrenTable {
  parent_user_id: string;
  student_id: string;
  relationship: Generated<"parent" | "guardian">;
  created_at: Timestamp;
}

export interface TenantStudentsTable {
  tenant_id: string;
  student_id: string;
  source: "school_roster" | "registration";
  created_at: Timestamp;
}

export interface SchoolStudentsTable {
  id: Generated<string>;
  tenant_id: string;
  school_id: string;
  student_id: string;
  grade: string | null;
  class_name: string | null;
  student_number: string | null;
  status: Generated<"active" | "left">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AuditLogsTable {
  id: Generated<string>;
  occurred_at: Timestamp;
  tenant_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  before: Json | null;
  after: Json | null;
  metadata: Json;
}

export interface CompetitionsTable {
  id: Generated<string>;
  tenant_id: string;
  slug: string;
  name: string;
  name_i18n: Json;
  description_i18n: Json;
  status: Generated<"draft" | "published" | "cancelled" | "archived">;
  visibility: Generated<"public" | "unlisted" | "private">;
  fee_mode: "free" | "paid";
  currency: string | null;
  timezone: string;
  interface_locales: string[];
  content_locales: string[];
  current_version_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  first_published_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
}

export interface CompetitionVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  competition_id: string;
  version_number: number;
  status: Generated<"draft" | "published" | "superseded">;
  config: Json;
  revision: Generated<number>;
  change_note: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: NullableTimestamp;
  published_by: string | null;
}

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  sessions: SessionsTable;
  schools: SchoolsTable;
  tenant_memberships: TenantMembershipsTable;
  students: StudentsTable;
  parent_children: ParentChildrenTable;
  tenant_students: TenantStudentsTable;
  school_students: SchoolStudentsTable;
  audit_logs: AuditLogsTable;
  competitions: CompetitionsTable;
  competition_versions: CompetitionVersionsTable;
}

export type Tenant = Selectable<TenantsTable>;
export type User = Selectable<UsersTable>;
export type School = Selectable<SchoolsTable>;
export type TenantMembership = Selectable<TenantMembershipsTable>;
export type Student = Selectable<StudentsTable>;
export type NewStudent = Insertable<StudentsTable>;
export type StudentUpdate = Updateable<StudentsTable>;
export type AuditLog = Selectable<AuditLogsTable>;
export type Competition = Selectable<CompetitionsTable>;
export type CompetitionVersion = Selectable<CompetitionVersionsTable>;
