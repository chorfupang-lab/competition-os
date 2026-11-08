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

Planned for later stages, not yet in the repo: a Next.js web app for the
portals, a Redis/BullMQ job queue (AI, certificates, notifications, webhooks,
recalculation), and S3-compatible object storage.

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

## Decisions to revisit

- **Schools are tenant-scoped in the MVP.** A school taking part with two
  organizers has a school record in each. The same school-admin login can
  hold memberships in both. A platform-level school directory can be added
  later without breaking this.
- **Tenant-wide student visibility** comes from the `students.read`
  permission (Competition Admin). Judges and Head Judges get student access
  through review cases in stage 6, not tenant-wide lists.
