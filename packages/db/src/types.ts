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
  platform_fee_bps: Generated<number>;
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
  registration_opens_at: NullableTimestamp;
  registration_closes_at: NullableTimestamp;
  waitlist_enabled: Generated<boolean>;
  consent_required: Generated<boolean>;
  requires_invite_code: Generated<boolean>;
  consent_version: Generated<string>;
  consent_text_i18n: ColumnType<unknown, string | undefined, string>;
  tax_rate_id: string | null;
  payment_hold_minutes: Generated<number>;
  results_publication: Generated<"on_approval" | "after_competition_ends" | "never">;
  leaderboard_privacy: Generated<"full_name" | "first_name_initial" | "nickname" | "anonymous_code" | "rank_score_only">;
  live_leaderboard: Generated<boolean>;
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

export interface SkillFrameworksTable {
  id: Generated<string>;
  tenant_id: string;
  key: string;
  name: string;
  name_i18n: Json;
  status: Generated<"active" | "archived">;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SkillsTable {
  id: Generated<string>;
  tenant_id: string;
  framework_id: string;
  parent_id: string | null;
  key: string;
  name: string;
  name_i18n: Json;
  description_i18n: Json;
  sort_order: Generated<number>;
  status: Generated<"active" | "archived">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContentBanksTable {
  id: Generated<string>;
  tenant_id: string;
  key: string;
  name: string;
  name_i18n: Json;
  description_i18n: Json;
  base_locale: string;
  required_locales: string[];
  skill_framework_id: string | null;
  status: Generated<"active" | "archived">;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LearningObjectivesTable {
  id: Generated<string>;
  tenant_id: string;
  bank_id: string;
  key: string;
  title: string;
  title_i18n: Json;
  skill_ids: string[];
  status: Generated<"active" | "archived">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContentItemsTable {
  id: Generated<string>;
  tenant_id: string;
  bank_id: string;
  external_key: string;
  content_type: string;
  base_locale: string;
  difficulty: "easy" | "medium" | "hard" | "expert";
  /** numeric comes back from pg as a string */
  points: ColumnType<string, number | string, number | string>;
  category: string | null;
  tags: string[];
  explanation: string | null;
  explanation_media: Json;
  source_reference: string | null;
  skill_ids: string[];
  objective_ids: string[];
  body: Json;
  status: Generated<"draft" | "ready" | "retired">;
  revision: Generated<number>;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContentItemTranslationsTable {
  id: Generated<string>;
  tenant_id: string;
  item_id: string;
  locale: string;
  strings: Json;
  source_hash: string;
  status: Generated<"draft" | "approved">;
  updated_by: string | null;
  approved_by: string | null;
  approved_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContentBankVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  bank_id: string;
  version_number: number;
  item_count: number;
  summary: Json;
  note: string | null;
  published_by: string | null;
  published_at: Timestamp;
}

export interface ContentVersionItemsTable {
  tenant_id: string;
  version_id: string;
  item_id: string;
  external_key: string;
  content_type: string;
  difficulty: "easy" | "medium" | "hard" | "expert";
  category: string | null;
  tags: string[];
  locales: string[];
  snapshot: Json;
}

export interface ContentImportsTable {
  id: Generated<string>;
  tenant_id: string;
  bank_id: string;
  filename: string | null;
  status: "validated" | "rejected" | "committed";
  row_count: number;
  rows: Json;
  errors: Json;
  summary: Json;
  created_by: string | null;
  created_at: Timestamp;
  committed_by: string | null;
  committed_at: NullableTimestamp;
}

type Money = ColumnType<string, number | bigint | string, number | bigint | string>;

export interface TenantPaymentAccountsTable {
  id: Generated<string>;
  tenant_id: string;
  provider: "airwallex" | "test";
  external_account_id: string;
  status: Generated<"active" | "disabled">;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaxRatesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  rate_bps: number;
  inclusive: boolean;
  status: Generated<"active" | "archived">;
  created_at: Timestamp;
}

export interface CompetitionPricesTable {
  id: Generated<string>;
  tenant_id: string;
  competition_id: string;
  group_id: string | null;
  label: Generated<string>;
  amount_minor: Money;
  starts_at: NullableTimestamp;
  ends_at: NullableTimestamp;
  status: Generated<"active" | "archived">;
  created_by: string | null;
  created_at: Timestamp;
}

export interface OfferCodesTable {
  id: Generated<string>;
  tenant_id: string;
  competition_id: string | null;
  code: string;
  kind: "percent" | "fixed";
  percent_bps: number | null;
  amount_minor: ColumnType<string | null, number | bigint | string | null, number | bigint | string | null>;
  purpose: Generated<"promotion" | "scholarship" | "invite" | "trial">;
  valid_from: NullableTimestamp;
  valid_until: NullableTimestamp;
  max_uses: number | null;
  max_uses_per_user: number | null;
  status: Generated<"active" | "disabled">;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrdersTable {
  id: string;
  tenant_id: string;
  order_number: string;
  competition_id: string;
  kind: "parent" | "school";
  buyer_user_id: string;
  school_id: string | null;
  status: "pending" | "paid" | "failed" | "cancelled" | "refunded" | "partially_refunded";
  payment_method: "online" | "invoice" | "none";
  currency: string;
  subtotal_minor: Money;
  discount_minor: Money;
  tax_minor: Money;
  total_minor: Money;
  refunded_minor: ColumnType<string, number | bigint | string | undefined, number | bigint | string>;
  tax_rate_bps: number | null;
  tax_inclusive: boolean | null;
  offer_code_id: string | null;
  platform_fee_bps: Generated<number>;
  platform_fee_minor: ColumnType<string, number | bigint | string | undefined, number | bigint | string>;
  invoice_due_at: NullableTimestamp;
  external_reference: string | null;
  expires_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  paid_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
}

export interface RegistrationsTable {
  id: string;
  tenant_id: string;
  competition_id: string;
  competition_version_id: string;
  group_id: string;
  student_id: string;
  registered_by_user_id: string;
  channel: "parent" | "school" | "admin";
  school_id: string | null;
  content_locale: string;
  declared_grade: string | null;
  status: "pending_payment" | "confirmed" | "waitlisted" | "cancelled";
  hold_expires_at: NullableTimestamp;
  waitlisted_at: NullableTimestamp;
  order_id: string | null;
  eligibility: Json;
  possible_duplicate_of: string | null;
  duplicate_resolution: "not_duplicate" | "cancelled" | null;
  needs_attention: string | null;
  cancel_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  confirmed_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
}

export interface OrderLinesTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  registration_id: string;
  description: string;
  unit_amount_minor: Money;
  discount_minor: Money;
  tax_minor: Money;
  total_minor: Money;
  refunded_minor: ColumnType<string, number | bigint | string | undefined, number | bigint | string>;
}

export interface OfferCodeRedemptionsTable {
  id: Generated<string>;
  tenant_id: string;
  offer_code_id: string;
  order_id: string;
  user_id: string;
  uses: number;
  status: Generated<"active" | "released">;
  created_at: Timestamp;
}

export interface PaymentsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  provider: "airwallex" | "test";
  provider_payment_id: string;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  amount_minor: Money;
  currency: string;
  gateway_fee_minor: ColumnType<string | null, number | bigint | string | null | undefined, number | bigint | string | null>;
  checkout: Json;
  failure_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  succeeded_at: NullableTimestamp;
}

export interface RefundsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  payment_id: string | null;
  amount_minor: Money;
  currency: string;
  reason: string;
  status: "pending" | "succeeded" | "failed";
  provider_refund_id: string | null;
  registration_ids: string[];
  requested_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: NullableTimestamp;
}

export interface WebhookEventsTable {
  id: Generated<string>;
  provider: string;
  event_id: string;
  event_type: string;
  tenant_id: string | null;
  payload: Json;
  received_at: Timestamp;
  processed_at: NullableTimestamp;
  processing_error: string | null;
}

export interface GatewayTransactionsTable {
  id: Generated<string>;
  tenant_id: string;
  provider: string;
  provider_txn_id: string;
  kind: "payment" | "refund";
  provider_ref: string;
  amount_minor: Money;
  fee_minor: Money;
  currency: string;
  settled_at: Timestamp;
  imported_by: string | null;
  imported_at: Timestamp;
}

export interface ConsentRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  competition_id: string;
  student_id: string;
  given_by_user_id: string;
  consent_type: "parent" | "school_attestation";
  consent_version: string;
  consent_text_hash: string;
  granted: boolean;
  ip: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface AttemptsTable {
  id: string;
  tenant_id: string;
  competition_id: string;
  competition_version_id: string;
  round_id: string;
  group_id: string;
  registration_id: string;
  student_id: string;
  started_by_user_id: string;
  attempt_number: number;
  kind: "official" | "practice";
  status: "in_progress" | "paused" | "submitted" | "invalidated";
  content_version_id: string;
  content_locale: string;
  seed: string;
  question_set: Json;
  started_at: ColumnType<Date, Date | string, Date | string>;
  deadline_at: ColumnType<Date, Date | string, Date | string>;
  extension_seconds: Generated<number>;
  submitted_at: NullableTimestamp;
  submit_reason: "participant" | "time_up" | "integrity_policy" | "admin" | null;
  score: Json | null;
  score_status: Generated<"not_scored" | "scored" | "pending_ai" | "pending_manual">;
  risk_score: Generated<number>;
  invalidated_at: NullableTimestamp;
  invalidated_reason: string | null;
  makeup_of: string | null;
  last_activity_at: ColumnType<Date, Date | string, Date | string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AttemptSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  attempt_id: string;
  device_id: string;
  fingerprint_hash: string | null;
  ip: string | null;
  user_agent: string | null;
  status: Generated<"active" | "superseded" | "closed">;
  started_at: Timestamp;
  last_seen_at: Timestamp;
}

export interface AttemptAnswersTable {
  tenant_id: string;
  attempt_id: string;
  item_id: string;
  response: Json | null;
  client_seq: number;
  client_saved_at: NullableTimestamp;
  saved_at: ColumnType<Date, Date | string, Date | string>;
  time_spent_ms: Generated<number>;
  change_count: Generated<number>;
  late_sync: Generated<boolean>;
  grade: Json | null;
}

export interface IntegrityEventsTable {
  id: Generated<string>;
  tenant_id: string;
  attempt_id: string;
  session_id: string | null;
  source: "client" | "server";
  type: string;
  details: Json;
  client_time: NullableTimestamp;
  server_time: Timestamp;
}

export interface RiskCasesTable {
  id: Generated<string>;
  tenant_id: string;
  attempt_id: string;
  status: Generated<"flagged" | "under_review" | "cleared" | "warning" | "disqualified">;
  risk_score: number;
  signals: Json;
  opened_by: string | null;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decision_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AttemptGrantsTable {
  id: Generated<string>;
  tenant_id: string;
  registration_id: string;
  round_id: string;
  replaces_attempt_id: string | null;
  reason: string;
  granted_by: string | null;
  available_until: NullableTimestamp;
  created_at: Timestamp;
}

export interface EmergencyActionsTable {
  id: Generated<string>;
  tenant_id: string;
  competition_id: string;
  round_id: string | null;
  group_id: string | null;
  kind: "extend_time" | "reopen_attempt" | "invalidate_attempt" | "makeup_attempt" | "disable_question" | "full_credit" | "replace_question" | "cancel_round";
  reason: string;
  actor_user_id: string;
  before: Json;
  after: Json;
  affected: Json;
  created_at: Timestamp;
}

export interface QuestionAdjustmentsTable {
  id: Generated<string>;
  tenant_id: string;
  competition_id: string;
  round_id: string;
  group_id: string | null;
  item_id: string;
  kind: "disabled" | "full_credit" | "replaced";
  replacement_item_id: string | null;
  emergency_action_id: string;
  created_at: Timestamp;
}

export interface AttemptScoreHistoryTable {
  id: Generated<string>;
  tenant_id: string;
  attempt_id: string;
  score: Json | null;
  score_status: string;
  reason: string;
  emergency_action_id: string | null;
  created_at: Timestamp;
}

export interface RoundStatesTable {
  tenant_id: string;
  competition_id: string;
  round_id: string;
  status: "cancelled";
  emergency_action_id: string;
  created_at: Timestamp;
}

export interface RiskCaseReviewsTable {
  id: Generated<string>;
  tenant_id: string;
  risk_case_id: string;
  reviewer_user_id: string;
  kind: "recommendation" | "decision" | "note";
  recommendation: "clear" | "warning" | "disqualify" | null;
  decision: "cleared" | "warning" | "disqualified" | null;
  note: string;
  created_at: Timestamp;
}

export interface ResultVersionsTable {
  id: string;
  tenant_id: string;
  competition_id: string;
  round_id: string;
  group_id: string;
  version_number: number;
  status: "draft" | "in_review" | "approved" | "published" | "superseded" | "discarded";
  competition_version_id: string;
  inputs: Json;
  changes: Json;
  summary: Json;
  trigger: "manual" | "recalculation";
  note: string | null;
  created_by: string | null;
  created_at: Timestamp;
  submitted_at: NullableTimestamp;
  approved_by: string | null;
  approved_at: NullableTimestamp;
  published_at: NullableTimestamp;
}

type Num = ColumnType<string | null, number | string | null, number | string | null>;

export interface ResultEntriesTable {
  tenant_id: string;
  result_version_id: string;
  registration_id: string;
  student_id: string;
  attempt_id: string | null;
  status: "ok" | "disqualified" | "no_attempt";
  total_score: Num;
  original_score: Num;
  accuracy: Num;
  time_ms: Num;
  hard_question_score: Num;
  submitted_at: NullableTimestamp;
  rank: number | null;
  tied_with: number | null;
  scope_ranks: Json;
  qualified: boolean;
  qualification_basis: string | null;
  overrides: Json;
}

export interface ResultReviewsTable {
  id: Generated<string>;
  tenant_id: string;
  result_version_id: string;
  reviewer_user_id: string;
  recommendation: "approve" | "changes_requested";
  note: string | null;
  created_at: Timestamp;
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
  skill_frameworks: SkillFrameworksTable;
  skills: SkillsTable;
  content_banks: ContentBanksTable;
  learning_objectives: LearningObjectivesTable;
  content_items: ContentItemsTable;
  content_item_translations: ContentItemTranslationsTable;
  content_bank_versions: ContentBankVersionsTable;
  content_version_items: ContentVersionItemsTable;
  content_imports: ContentImportsTable;
  tenant_payment_accounts: TenantPaymentAccountsTable;
  tax_rates: TaxRatesTable;
  competition_prices: CompetitionPricesTable;
  offer_codes: OfferCodesTable;
  orders: OrdersTable;
  registrations: RegistrationsTable;
  order_lines: OrderLinesTable;
  offer_code_redemptions: OfferCodeRedemptionsTable;
  payments: PaymentsTable;
  refunds: RefundsTable;
  webhook_events: WebhookEventsTable;
  gateway_transactions: GatewayTransactionsTable;
  consent_records: ConsentRecordsTable;
  attempts: AttemptsTable;
  attempt_sessions: AttemptSessionsTable;
  attempt_answers: AttemptAnswersTable;
  integrity_events: IntegrityEventsTable;
  risk_cases: RiskCasesTable;
  attempt_grants: AttemptGrantsTable;
  emergency_actions: EmergencyActionsTable;
  question_adjustments: QuestionAdjustmentsTable;
  attempt_score_history: AttemptScoreHistoryTable;
  round_states: RoundStatesTable;
  risk_case_reviews: RiskCaseReviewsTable;
  result_versions: ResultVersionsTable;
  result_entries: ResultEntriesTable;
  result_reviews: ResultReviewsTable;
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
export type ContentBank = Selectable<ContentBanksTable>;
export type ContentItem = Selectable<ContentItemsTable>;
export type ContentItemTranslation = Selectable<ContentItemTranslationsTable>;
export type Order = Selectable<OrdersTable>;
export type Registration = Selectable<RegistrationsTable>;
export type Payment = Selectable<PaymentsTable>;
export type Refund = Selectable<RefundsTable>;
export type Attempt = Selectable<AttemptsTable>;
export type AttemptSession = Selectable<AttemptSessionsTable>;
export type ResultVersion = Selectable<ResultVersionsTable>;
export type ResultEntryRow = Selectable<ResultEntriesTable>;
