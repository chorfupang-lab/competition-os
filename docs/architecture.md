# Architecture

This records the technical decisions so far and the reasons behind them.
Product rules live in [product-requirements.md](product-requirements.md);
where a decision implements a "hard rule" from that file, the rule number is
given (e.g. HR16).

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 22) across all services | One language for API, workers and web; types shared via `packages/core` |
| API | Fastify 5 | Fast, mature, good plugin model (cookies, rate limiting) |
| Database | PostgreSQL 16 | Relational core for transactions; row-level security for tenant isolation |
| Query layer | Kysely + hand-written SQL migrations | Typed queries; SQL stays explicit, which matters for RLS policies |
| Validation | Zod | Request validation with field-level errors |
| Passwords | argon2id (`@node-rs/argon2`) | Current recommended password hash |
| Tests | Vitest against real PostgreSQL | Isolation is enforced in the DB, so it must be tested there |
| Local infra | Docker Compose | Cloud-neutral; production can be AWS, GCP, Azure or managed Postgres |

Background work runs in a worker process (`apps/api/src/worker.ts`) that
uses PostgreSQL only: it finds due work with `SECURITY DEFINER` lookups and
locks rows with `FOR UPDATE SKIP LOCKED`. **Decision:** no Redis for now.
Postgres-backed work is transactional with the data it changes, and one less
service to run. Revisit if job volume (AI, notifications) outgrows it.

Planned for later stages, not yet in the repo: a Next.js web app for the
portals, and S3-compatible object storage.

## Multi-tenancy and isolation

Structure: **Platform → Tenant → (Competitions → Rounds → Groups, from stage 2)**.

Isolation is enforced in two layers:

1. **API authorization.** Each tenant route resolves a `TenantScope`: the
   caller's active memberships, permissions, and school scope. It checks the
   route's permission (`requirePermission`) before touching data. A tenant the
   caller doesn't belong to returns `404`, exactly as a non-existent tenant
   does, so tenant IDs can't be probed.
2. **PostgreSQL row-level security (RLS).** The API connects as `cos_app`,
   which is not the table owner and has no `BYPASSRLS`. Every request runs in
   a transaction that first sets `app.user_id`, `app.tenant_id`,
   `app.platform_admin`, `app.tenant_wide` and `app.school_ids`
   (`withContext` in `packages/db`). Policies on every table read those
   values. So a query that forgets a `tenant_id` filter still cannot return
   or write another tenant's rows; the tests check this directly.

Inside tenant routes, even a Platform Admin's database context is pinned to
that one tenant. Only `/platform/*` routes use the RLS bypass for platform
admins, and every change there is audited.

Tables are either **tenant-scoped** (`tenant_id` column; schools,
memberships, school rosters) or **platform-level** (users, students,
parent-child links). Platform-level rows have relationship-based policies.

`cos_app` has **no DELETE privilege** on any table. Removal happens through
status changes (revoked, archived, left) and, from stage 10, anonymization.
History is never lost (HR10, HR25, HR32).

## Identity

- **Users** are platform-level logins. One user can be a parent, hold roles
  in several tenants, and so on. Login is by email, or by username for
  children without email.
- **Students** are platform-level identities with a permanent Student ID
  (`S` + 9 Crockford base32 characters, e.g. `S148MDNQA7`). They persist
  across tenants and years (HR21) and may optionally have their own login.
- A student's connection to a tenant is an explicit `tenant_students` row,
  created by a school roster now and by registrations in stage 4. Tenant
  staff see only students connected to their tenant. They never see that a
  student also takes part elsewhere (HR22).
- Parents see all their linked children, whatever the tenant (HR3, HR23). A
  parent can link only a student they created themselves. Claiming an
  existing student (e.g. one a school created) will be a separate,
  verified, pending-link workflow. Identities are never merged on name alone.

## Roles and permissions

Defined once in `packages/core/src/permissions.ts`; the API is the only
authority (HR: "production authorization must be server-side").

- **Platform role:** `platform_admin`. It can be granted only by the
  owner-level CLI script (`pnpm db:create-platform-admin`), never through the
  API. `cos_app` cannot even update that column.
- **Tenant roles** (memberships): `competition_admin`, `school_admin`
  (always tied to one school), `judge`, `head_judge`.
- **Relationship roles:** parent and student. Access is resource-based (own
  children, own profile).

**Head Judge only (HR16):** `result.override` and `integrity.disqualify` are
held by Head Judge alone. Platform Admin does not get them either. A Platform
Admin who must act grants themselves Head Judge in that tenant, and the grant
is audited.

**Competition Admin and tenant administration:** in the MVP the Competition
Admin also manages tenant members and schools. Per-competition scoping of
Competition Admins arrives with competitions in stage 2.

## Authentication

- Opaque random session tokens (32 bytes). Only their SHA-256 hash is
  stored. Sessions are revocable and expire after `SESSION_TTL_HOURS`.
- Browsers use the `cos_session` cookie (httpOnly, SameSite=Lax, Secure in
  production). Apps and scripts use `Authorization: Bearer`.
- CSRF: cookie-authenticated changes must carry an allowed `Origin`, or
  `Sec-Fetch-Site: same-origin`. Bearer requests aren't exposed to CSRF.
- Sign-in reveals nothing about whether an account exists: the same error,
  and a dummy hash check for unknown accounts. Failed attempts are audited
  and rate-limited.
- Credentials are read only through narrow `SECURITY DEFINER` functions
  (`app.auth_*`), which return just what that step needs.
- Not yet: email verification and password reset (they need notifications,
  stage 8), and SSO (deferred per MVP scope).

## Audit log

`audit_logs` is append-only. `cos_app` can only insert and read, and a
trigger rejects UPDATE, DELETE and TRUNCATE even for the owner. Each entry
records the actor, time, action, target, reason, before/after values, and
request metadata (request ID, IP, user agent, whether the actor was acting as
Platform Admin). It is written in the same transaction as the change it
describes, so the two always commit together. Sensitive actions such as
tenant suspension and membership revocation require a reason (HR9).

A future data-retention purge will need a deliberate, owner-level procedure
that disables the trigger. That is intentional.

## Internationalization

- Supported locales: `en`, `zh-Hant`, `zh-Hans`, `th`. Regional tags are
  normalized (`zh-HK` → `zh-Hant`, `zh-CN` → `zh-Hans`).
- Interface language (`users.locale`) and content language (per content
  item, from stage 3) are independent (HR5).
- API error `code`s are stable. Messages are localized from
  `Accept-Language`.
- Names that admins enter in several languages (tenant, school) use a
  `name_i18n` JSON map. Content translations will get their own tables, per
  the content-bank design.
- Tenants carry a timezone, country and default currency (HR34).

## Duplicate students

Roster uploads detect possible duplicates: the same name and date of birth
already on the roster, or repeated within the upload. They are never silently
dropped or merged. A `dryRun` previews them. Without `confirmDuplicates`, the
whole upload is refused with the list, so the admin decides.

## Competition engine (stage 2)

**Configuration as a versioned document.** A competition's rounds, groups
and per-round-group rules live in one JSON configuration per version
(`competition_versions.config`), validated by the Zod schema in
`packages/core/src/competition/config.ts`. We chose this over one row per
round, group and setting because:
- a version is a single immutable snapshot, which is easy to lock, diff,
  audit and roll forward;
- the schema is shared with the future web app, so admins get the same
  validation in the browser;
- results will refer to a version id plus stable round and group ids, so
  history stays exact.

The trade-off is that cross-competition queries ("all rounds opening this
week") need JSON queries. If such reporting grows, materialize a read model.

**Stable ids.** Rounds and groups use client-generated UUIDs that never
change across versions. Keys (`primary`, `final`) are for people and may be
renamed.

**Lifecycle.**
- Competition status: draft → published → cancelled/archived.
- Version status: draft → published → superseded.
- At most one draft and one published version at a time (unique indexes).
- A database trigger freezes published and superseded versions.
- Fee mode, currency and timezone lock at the first publish (HR29).

**Planned change vs emergency.** A new version is a planned change.
Publishing it is refused if it would alter or remove a round that has
already opened, or change the eligibility of a group in such a round. Those
cases are live incidents and will go through audited emergency actions in
stage 6 (HR8, HR9).

**Engines are pure and deterministic** (`packages/core/src/competition`).
- No I/O, no clock unless passed in, and no randomness.
- Scores are rounded to 3 decimals.
- Rankings break full ties by sharing the rank ("1, 2, 2, 4") and list tied
  participants by id.
- Top % rounds down.
- Ties at a cut-off follow the rule's `ties` setting.
- Manual overrides need a reason and are capped by `maxWildcards`.
- Practice rounds cannot qualify anyone (HR20). AI is not involved (HR17,
  HR18).

**Grades** are normalized to a level (-2…12) so one rule can cover Hong Kong
(P/S/F), mainland China (小/初/高), Thailand (อ./ป./ม.) and US-style grades.
Unknown grades fail eligibility with `MISSING_GRADE` rather than being
guessed.

**Competition-scoped roles.** A membership may carry `competition_id`.
- Scoped memberships grant only competition-level permissions
  (`COMPETITION_SCOPED_PERMISSIONS`), and only for that competition.
- Tenant-wide powers need an unscoped membership.
- This is enforced in the API. RLS still enforces the tenant boundary
  underneath.

**Public catalog.**
- RLS lets anyone read published `public` or `unlisted` competitions of
  active tenants, plus only their current version.
- The API returns a public projection (`publicConfigView`), which leaves out
  content bank ids, scoring weights, qualification parameters and integrity
  tuning.
- Organizer names come from a narrow `SECURITY DEFINER` function, because
  tenants themselves are not publicly readable.

## Content engine (stage 3)

**Working set vs published version.**
- A bank's items are an editable working set (`content_items`).
- Publishing copies every `ready` item into an immutable Content Bank
  Version (`content_version_items.snapshot`). Each snapshot holds the item,
  its current approved translations, and the keys of its skills and
  objectives.
- Competitions store only the version id (HR11). Editing or retiring a
  working item never changes a published version. This copies data, but
  questions are small and media are links.

**Item model.**
- Shared metadata sits in columns (type, difficulty, points, category,
  tags, skills, objectives, explanation, source).
- The type-specific part is a JSON `body`, validated by per-type Zod schemas
  in `packages/core/src/content/items.ts`.
- Stored rows are re-validated whenever they are read for publishing.

**Translations are separate** (HR13, `content_item_translations`).
- A translation is a map from text path to text, e.g. `prompt`,
  `options.b.text`, `explanation`.
- `translatableStrings()` decides which paths exist. Answers, accepted
  text answers and pronunciation targets are never translatable, so a
  Mandarin reading item keeps its Mandarin target in every interface
  language.
- Each translation stores a hash of the source strings it was made from.
  When the base text changes, the hash no longer matches, so it is marked
  stale and left out of the next version. That way a translation of an old
  wording can never reach a published version.

**Grading** (`content/grading.ts`) is deterministic and returns an outcome
plus a fraction. The round's scoring rule (stage 2) turns that into points.
Pronunciation returns `pending_ai` and custom items return
`pending_manual`, so a participant is never blocked waiting for AI (section
12 of the requirements).

**Skill and objective references** are uuid arrays on the item, not join
tables, because the application role has no DELETE. The API checks them
against the bank's framework and objectives on every save, at import and at
publish.

**Excel import** (`apps/api/src/lib/excel.ts`, `content-import.ts`).
- The parser is `exceljs`, chosen because the npm `xlsx` package is
  unmaintained.
- Uploads are limited to 10 MB and 5,000 rows.
- An upload is stored as a `content_imports` row: the parsed rows, a
  row-level error list and a summary.
- Commit re-plans against the current bank, so a stale preview is never
  applied.
- Re-uploading the same `content_id` updates that item (the revision is
  bumped), and identical rows are reported as unchanged.

**Competition linkage.** `validateContentReferences` (core) runs whenever a
competition config is saved or published.
- The version must be found through RLS, i.e. it must belong to this
  tenant.
- The pool, after question formats and filters, must cover `questionCount`.
- It warns when items lack the competition's content locales.

## Registration and payments (stage 4)

See [payments.md](payments.md) for the money flow and the Airwallex go-live
checklist.

**Parents never get a tenant context.**
- A parent registering with an organizer acts as themselves: RLS lets them
  insert registrations for their own children, orders they buy, and lines
  and payments on those orders.
- What they need from the tenant comes through narrow `SECURITY DEFINER`
  functions: prices, tax, seat counts, offer-code lookup and usage, and the
  payment account.
- Connecting the child to the tenant goes through
  `app.connect_student_to_tenant`, which checks parenthood and a published
  competition.
- Audit entries may be written into the organizer's tenant only when they
  are attributed to the caller.

**System actor.** Webhooks, hold expiry and waitlist promotion run as
`systemTenantContext(tenantId)`: no user, confined to one tenant, never
derived from request input. Only the raw webhook record uses the
platform-wide context, because its tenant is not known until the payment is
looked up.

**Concurrency.** Registration attempts for a competition are serialized with
a transaction-level advisory lock, and offer-code use with a per-code lock.
Seats count confirmed registrations plus unexpired holds. No provider call
is made while a transaction is open.

**Statuses.**
- Registration: `pending_payment`, `confirmed`, `waitlisted`, `cancelled`.
- Order: `pending`, `paid`, `failed`, `cancelled`, `refunded`,
  `partially_refunded`.
- Payment: `pending`, `succeeded`, `failed`, `cancelled`.
- Refund: `pending`, `succeeded`, `failed`.

These cover the requirement's payment states (Pending / Paid / Failed /
Refunded / Cancelled) at the order level.

## Competition runtime (stage 5)

See [runtime.md](runtime.md) for the client contract.

**Authorization pattern.** A participant (the student, or a parent for a
young child) is first authorized in their personal context. RLS lets them
see only their own or their children's attempts and registrations. The
runtime then acts inside that competition's tenant, as the participant, to
read content snapshots and write answers, sessions and signals. It never
gains wider reach than that one tenant.

**Determinism and audit.** Each attempt stores its seed, question set,
content version and competition version. Grading and scoring are pure
functions of those plus the saved answers. So an attempt can be re-scored
exactly (stage 6 recalculation) or reconstructed for an appeal.

**Signals are not verdicts** (HR19). Signals are stored as
`integrity_events`, and the score in `risk_cases`. A case starts `flagged`;
judges move it through review in stage 6.

## Decisions to revisit

- **Schools are tenant-scoped in the MVP.** A school taking part with two
  organizers has a school record in each. The same school-admin login can
  hold memberships in both. A platform-level school directory can be added
  later without breaking this.
- **Fullscreen "pause" keeps the timer running.** Pausing hides the
  questions until fullscreen returns, so leaving fullscreen never buys
  extra time. Extensions are an explicit Head Judge action instead.
- **Private competitions are school/admin-only.** Parents register for
  public or unlisted competitions. Unlisted plus "requires invite code" is
  the invite-only option.
- **Changing group with a different price is refused.** The admin cancels
  and re-registers instead, refunding if needed. Charging or refunding the
  price difference automatically can come later.
- **Tenant-wide student visibility** comes from the `students.read`
  permission (Competition Admin). Judges and Head Judges get student access
  through review cases in stage 6, not tenant-wide lists.
