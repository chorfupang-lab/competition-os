# Roadmap

| # | Stage | Status |
|---|---|---|
| 1 | **Product foundation**: DB, auth, tenants, roles, permissions, isolation, schools/rosters, parents/children, audit | ✅ Done |
| 2 | Competition engine: competitions, config versions, rounds, groups, per-round-group rules, eligibility, attempt policy, scoring, qualification | Next |
| 3 | Content engine: content banks and versions, items, translations, skills, learning objectives, media, difficulty, Excel import | |
| 4 | Registration and payment: parent/school registration, pricing, offer codes, tax, Airwallex hosted checkout, webhooks, receipts, refunds, reconciliation | |
| 5 | Competition runtime: server timer, autosave/resume, devices/sessions, anti-cheat signals | |
| 6 | Judging and results: review cases, Head Judge approval/override, emergency actions, result versions, recalculation, publication | |
| 7 | Learning Passport and AI: skills over time, pronunciation AI adapter, AI job queue, output validation, practice sets | |
| 8 | Certificates and notifications | |
| 9 | SaaS commercial layer: plans, limits, subscriptions, platform fees, AI cost | |
| 10 | Privacy and internationalization: consent, export, deletion/anonymization, retention | |
| 11 | Production: deployment, monitoring, backups/restore, security review | |

Web portals (admin, school, parent, student, judge) will be built alongside
stages 2–4, once there are flows worth putting on screen.

## Stage 1 — what is in place

- PostgreSQL schema with RLS on every table, and a restricted `cos_app` role
  with no DELETE.
- Email or username login, sessions (cookie and Bearer), CSRF origin check,
  rate limiting, argon2id.
- Platform Admin, created only by an owner-level script.
- Tenants: create, suspend or reactivate with a reason; suspended tenants are
  blocked for members.
- Tenant roles: grant and revoke with a reason; School Admin scoped to one
  school.
- Schools and bulk roster upload (≤500 rows) with duplicate review.
- Parents: multiple children, each with a permanent Student ID; child
  username logins.
- Append-only audit log, written in the same transaction as each change.
- Localized error messages in 4 locales.
- 51 tests (46 API integration tests against a real database, 5 unit tests): cross-tenant reads and writes,
  school scoping, parent privacy, role escalation, audit immutability.

## Known gaps carried forward

- Email verification, password reset, invitations: stage 8 (notifications).
- Claiming an existing student, and cross-tenant identity matching: stage 4.
- Consent records: stage 4 (taken during registration).
- Anonymization endpoints: stage 10.
