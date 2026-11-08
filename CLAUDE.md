# Competition OS — notes for AI assistants

Read `docs/product-requirements.md` (product decisions and 35 hard rules),
`docs/architecture.md` and `docs/roadmap.md` before changing anything.

## Working style
- Requirements are settled. Don't re-ask product questions. When something
  is unspecified, make a sensible, modular choice, keep the MVP simple, and
  explain material trade-offs.

## Rules this codebase enforces (don't weaken them)
- Tenant isolation is enforced twice: API permission checks AND PostgreSQL
  RLS. Every DB access goes through `withContext()` with the right context.
  Tenant routes pin the context to one tenant, even for Platform Admins.
- New tables: add RLS policies in the migration, grant `cos_app` only what is
  needed, never DELETE. Use status changes or anonymization instead.
- Insert rows the caller can't yet SELECT with an app-generated id and no
  RETURNING / ON CONFLICT (both apply SELECT policies).
- Every change that matters writes an audit entry in the same transaction.
  Sensitive actions require a reason.
- Official result override and disqualification are Head Judge only, not
  even Platform Admin (`HEAD_JUDGE_ONLY` in packages/core).
- AI never decides official score, rank or qualification.
- Migrations are append-only: never edit an applied file; add a new one and
  update `packages/db/src/types.ts`.

## Commands
- `pnpm typecheck`, `pnpm test` (needs PostgreSQL; see README)
- `pnpm db:migrate`, `pnpm db:create-platform-admin --email ...`
