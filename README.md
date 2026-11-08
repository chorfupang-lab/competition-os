# Competition OS

A multi-tenant **Competition Operating System**: one platform where many
organizations run competitions with their own rounds, groups, rules, content,
payments, judging, certificates and student Learning Passports.

- Product requirements: [docs/product-requirements.md](docs/product-requirements.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Roadmap and status: [docs/roadmap.md](docs/roadmap.md)

## Status

**Stages 1–3 of 11 are complete.**
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
