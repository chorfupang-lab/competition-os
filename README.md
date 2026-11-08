# Competition OS

A multi-tenant **Competition Operating System**: one platform where many
organizations run competitions with their own rounds, groups, rules, content,
payments, judging, certificates and student Learning Passports.

- Product requirements: [docs/product-requirements.md](docs/product-requirements.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Roadmap and status: [docs/roadmap.md](docs/roadmap.md)

## Status

**Stage 1 of 11 is complete: Product foundation.** It covers the database,
login, tenants, roles, permissions, tenant isolation, schools and rosters,
parents and children, and the audit log. This is a backend API only; the web
portals come later. See the roadmap for what each stage adds.

## Repository layout

```
apps/api          HTTP API (Fastify). Routes, authorization, integration tests.
packages/core     Shared rules with no I/O: roles, permissions, locales, error codes.
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

## API overview (stage 1)

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
