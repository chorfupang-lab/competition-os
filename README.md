# Competition OS

A multi-tenant **Competition Operating System**: one platform where many
organizations run competitions with their own rounds, groups, rules, content,
payments, judging, certificates and student Learning Passports.

- Product requirements: [docs/product-requirements.md](docs/product-requirements.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Roadmap and status: [docs/roadmap.md](docs/roadmap.md)

## Status

**Stages 1–6 of 11 are complete.**
- Stage 1, product foundation: database, login, tenants, roles and
  permissions, tenant isolation, schools and rosters, parents and children,
  and the audit log.
- Stage 2, competition engine: competitions, versioned configurations,
  rounds and groups with per-round-group rules, eligibility, attempt policy,
  scoring, ranking, qualification, competition-scoped roles, and the public
  catalog.
- Stage 3, content engine: skill frameworks, content banks, learning
  objectives, all 13 question types with answer checking, translations kept
  separate from questions, the Excel template and import, and immutable
  published Content Bank Versions that competitions reference.
- Stage 4, registration and payment: parent and school registration,
  eligibility, consent, capacity and waitlist, duplicate flags, prices, tax,
  offer codes, hosted checkout through a provider adapter (Airwallex plus a
  test gateway), signed idempotent webhooks, receipts and invoices, refunds,
  reconciliation and tenant economics. See [docs/payments.md](docs/payments.md).
- Stage 5, competition runtime: server-authoritative timer, per-attempt
  question selection, autosave with offline sync and resume, device and
  session control, browser and server integrity signals, risk scoring and
  flagged cases, auto-submit, and a background worker. See
  [docs/runtime.md](docs/runtime.md).
- Stage 6, judging and results: integrity review (Head Judge-only
  disqualification), manual grading, Head Judge emergency actions with
  re-scoring, versioned official results (draft → judge review → Head Judge
  approval → published, with before/after diffs and overrides), qualification
  gating the next round, and privacy-aware leaderboards. See
  [docs/results.md](docs/results.md).

This is a backend API only; the web portals come later. See the roadmap for
what each stage adds.

## Repository layout

```
apps/api          HTTP API (Fastify). Routes, authorization, integration tests.
packages/core     Shared rules with no I/O: roles, permissions, locales, error codes,
                  and the competition engine (config schema, eligibility, scoring,
                  ranking, qualification, validation), and the content engine
                  (question-type schemas, grading, translations).
packages/db       PostgreSQL schema (SQL migrations with row-level security),
                  typed query layer (Kysely), migration runner, admin scripts.
infra/            Local infrastructure config.
docs/             Requirements, architecture, roadmap.
```

## Running locally

Requirements: Node 22+, pnpm 10, Docker (or your own PostgreSQL 16).

```bash
pnpm install
docker compose up -d                 # PostgreSQL with the cos_owner and cos_app roles
cp .env.example .env                 # then load it: set -a; source .env; set +a
pnpm db:migrate
pnpm db:create-platform-admin --email you@example.com --name "Your Name"
pnpm dev                             # API on http://localhost:3000
pnpm worker                          # background worker (auto-submit, seat-hold sweep)
```

The admin script prints a generated password once if you don't pass `--password`.

## Tests

```bash
pnpm typecheck
pnpm test
```

The API tests run against a real PostgreSQL, because tenant isolation is
enforced by the database and must be tested there. The test setup creates and
drops its own database. It connects with `TEST_DATABASE_ADMIN_URL`, which
defaults to the docker-compose superuser.

## API overview

All responses are JSON. Errors look like
`{"error": {"code": "FORBIDDEN", "message": "<localized>", "details": ...}}`.
The `code` is stable. The `message` follows `Accept-Language`
(`en`, `zh-Hant`, `zh-Hans`, `th`).

Clients authenticate with the `cos_session` httpOnly cookie (browsers) or an
`Authorization: Bearer <token>` header (apps and scripts). For cookie requests
that change data, the `Origin` must be in `ALLOWED_ORIGINS`.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /auth/register` | anyone | Create an account (parents start here) |
| `POST /auth/login` / `POST /auth/logout` | anyone / signed in | Sign in by email or username |
| `GET /me`, `PATCH /me` | signed in | Profile, tenant memberships, children, own student profile |
| `GET/POST /me/children`, `GET /me/children/:id` | parent | Manage children (each gets a platform Student ID) |
| `POST /me/children/:id/login` | parent | Create a username login for a child |
| `GET/POST /platform/tenants` | Platform Admin | List and create tenants |
| `POST /platform/tenants/:id/status` | Platform Admin | Suspend or reactivate (reason required) |
| `GET /platform/audit-logs` | Platform Admin | Cross-tenant audit log |
| `GET /t/:tenantId` | tenant member | Tenant, my roles and permissions |
| `GET/POST /t/:tenantId/members`, `POST .../members/:id/revoke` | Competition Admin | Grant and revoke tenant roles |
| `GET/POST /t/:tenantId/schools` | Competition Admin (School Admin reads own) | Schools |
| `GET/POST /t/:tenantId/schools/:id/students` | Competition Admin, that school's School Admin | Roster and bulk upload (up to 500, with duplicate review) |
| `GET /t/:tenantId/students`, `GET .../students/:id` | Competition Admin (School Admin: own school's students) | Students connected to this tenant |
| `GET /t/:tenantId/audit-logs` | Competition Admin | Tenant audit log |
| `GET/POST /t/:tenantId/competitions` | Competition Admin (scoped admins list their own) | List and create competitions (starts as draft v1) |
| `GET/PATCH /t/:tenantId/competitions/:id`, `POST .../cancel` | Competition Admin of that competition | Details, edit, cancel (reason required) |
| `POST .../competitions/:id/versions` | same | New draft from the published version |
| `GET .../versions/:vid`, `PUT .../versions/:vid/config` | same | Read or save a draft config (send `revision`), with validation issues |
| `POST .../versions/:vid/publish` | same | Publish; blocked by errors; change note required from v2 |
| `POST .../versions/:vid/simulate` | same, or `ranking.read` | Dry-run ranking and qualification on sample scores |
| `POST .../competitions/:id/eligibility` | Competition or registration admin | Group eligibility for a student, or a date of birth and grade |
| `GET /competitions`, `GET /competitions/:id` | anyone | Public catalog of published competitions |
| `GET /me/children/:id/eligibility/:competitionId?grade=P4` | parent | Which groups a child may enter |
| `GET/POST /t/:tenantId/content/skill-frameworks`, `.../:id/skills` | Competition Admin (read: also Judges) | Skill frameworks (hierarchical) |
| `GET/POST /t/:tenantId/content/banks`, `GET/PATCH .../banks/:id` | same | Content banks (base locale, required locales, skill framework) |
| `GET/POST .../banks/:id/objectives` | same | Learning objectives |
| `GET/POST .../banks/:id/items`, `GET/PUT .../items/:itemId` | same | Questions (send `revision` when editing) |
| `POST .../items/:itemId/status` | same | draft / ready / retired (reason required) |
| `PUT .../items/:itemId/translations/:locale` | same | Save or approve a translation |
| `GET .../items/:itemId/preview?locale=th`, `POST .../grade` | same | Localized preview; try an answer |
| `GET .../banks/:id/import-template` | same | Download the Excel template |
| `POST .../banks/:id/imports` (raw .xlsx), `GET .../imports/:importId`, `POST .../commit` | same | Validate → preview / error report → commit |
| `POST .../banks/:id/versions`, `GET .../versions/:versionId/items` | same | Publish an immutable Content Bank Version; read it |
| `POST /me/registrations/quote`, `POST /me/registrations` | parent | Eligibility, price, seat; register (consent, offer code) and open checkout |
| `GET /me/registrations`, `POST /me/registrations/:id/cancel` | parent | List; withdraw unpaid or waitlisted |
| `GET /me/orders`, `GET /me/orders/:id`, `POST .../checkout`, `GET .../receipt` | parent | Orders, retry checkout, HTML receipt |
| `PATCH /t/:tenantId/competitions/:id/registration-settings` | Competition Admin | Window, waitlist, consent text/version, invite-only, tax, hold time |
| `GET/POST .../competitions/:id/prices`, `POST .../prices/:pid/archive` | Competition Admin | Prices per group, with optional early-bird windows |
| `GET/POST /t/:tenantId/tax-rates`, `GET/POST /t/:tenantId/offer-codes` | `payments.manage` | Tax rates; offer codes (promotion, scholarship, invite, trial) |
| `GET .../competitions/:id/registrations` | `registrations.manage` | Registrations and per-group counts (`attention=true` for flagged) |
| `POST /t/:tenantId/registrations/:id/cancel`, `change-group`, `transfer`, `duplicate` | `registrations.manage` | Cancel, amend, transfer, resolve duplicate flags (reasons required) |
| `POST .../competitions/:id/school-registrations` | School Admin (own school) | Bulk registration from the roster; `dryRun` preview; invoice or online |
| `GET /t/:tenantId/orders`, `GET .../orders/:id`, `POST .../refunds`, `POST .../mark-paid`, `GET .../receipt` | `payments.manage` | Search, detail with economics, refund, record invoice payment |
| `POST /t/:tenantId/payments/gateway-transactions` (+ `/sync`), `GET .../reconciliation`, `GET .../summary` | `payments.manage` | Reconciliation and tenant net |
| `POST /platform/tenants/:id/payment-accounts`, `POST .../platform-fee` | Platform Admin | Connect the tenant's merchant account; platform fee |
| `POST /webhooks/payments/:provider` | the gateway | Signed payment and refund events |
| `GET /me/rounds` | student / parent | Rounds with state and attempts left |
| `POST /me/attempts`, `GET /me/attempts/:id` | student / parent | Start or resume (device + session); full state |
| `PUT /me/attempts/:id/answers`, `POST .../heartbeat`, `.../events`, `.../resume`, `.../submit` | student / parent | Autosave, keep-alive, integrity signals, resume after pause, submit |
| `GET /t/:tenantId/competitions/:id/attempts`, `GET /t/:tenantId/attempts/:attemptId` | Judge / Competition Admin | Attempts with risk; full review view (questions as shown, answers, grades, sessions, signals) |
| `GET .../competitions/:id/risk-cases`, `GET /t/:tenantId/risk-cases/:id`, `POST .../reviews`, `POST .../decision` | Judge (disqualify: Head Judge) | Integrity review |
| `POST /t/:tenantId/attempts/:id/risk-case`, `POST .../grades` | Judge (re-grade: Head Judge) | Open a case; grade pending questions |
| `POST/GET .../competitions/:id/results`, `GET /t/:tenantId/results/:vid` | Competition Admin, Judges | Compute a draft (overrides: Head Judge); versions; entries |
| `POST /t/:tenantId/results/:vid/submit`, `/reviews`, `/approve`, `/discard` | see docs/results.md | Review workflow; approval publishes (Head Judge) |
| `POST .../competitions/:id/emergency/extend-time`, `reopen-attempt`, `invalidate-attempt`, `makeup-attempt`, `questions`, `cancel-round`; `GET .../emergency` | Head Judge | Emergency actions and their log |
| `PATCH .../competitions/:id/results-settings` | Competition Admin | Publication mode, leaderboard privacy, live board |
| `GET /competitions/:id/leaderboard?roundId&groupId` | anyone | Public leaderboard (official or provisional) |
| `GET /me/results` | parent / student | Own published results |
