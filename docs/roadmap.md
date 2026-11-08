# Roadmap

| # | Stage | Status |
|---|---|---|
| 1 | **Product foundation**: DB, auth, tenants, roles, permissions, isolation, schools/rosters, parents/children, audit | ✅ Done |
| 2 | **Competition engine**: competitions, config versions, rounds, groups, per-round-group rules, eligibility, attempt policy, scoring, ranking, qualification | ✅ Done |
| 3 | Content engine: content banks and versions, items, translations, skills, learning objectives, media, difficulty, Excel import | Next |
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

## Stage 2 — what is in place

- Competitions per tenant: free or paid, fixed currency, timezone, interface
  and content locales, and public, unlisted or private visibility.
- A versioned configuration document holds groups, eligibility and rounds,
  with per-round-group settings for timing, question formats, content
  source, UI, scoring, ranking, qualification and integrity.
- Draft → published → superseded versions. A published version is immutable
  (database trigger). Drafts are saved with revision checks against
  overwrites. Each publish stores a diff in the audit log, and a change note
  is required from v2.
- A validator with errors (which block publishing) and warnings. Rounds that
  have opened are locked against planned changes; live changes will use
  emergency actions (stage 6).
- Fee mode, currency and timezone lock at the first publish.
- Deterministic engines in `packages/core`: grade normalization
  (HK/CN/TH/US), eligibility (age on a cutoff date, birth-date window,
  grade level, grade list, all/any), scoring (item points, negative
  marking, partial credit, difficulty weights, disabled-question and
  full-credit adjustments), attempt policy (best/latest/first, make-up
  grants), ranking (ordered tie-breakers, shared ranks, scopes), and
  qualification (top N, top %, score, rank, any/all, per-scope quota, tie
  policy, reasoned manual overrides with a wildcard limit).
- Competition-scoped memberships: a Competition Admin, Judge or Head Judge
  can be limited to one competition.
- A public catalog (no login) and a parent eligibility check for each child.
- A simulation endpoint, so admins can test ranking and qualification rules.
- 123 tests in total.

## Known gaps carried forward

- Email verification, password reset, invitations: stage 8 (notifications).
- Claiming an existing student, and cross-tenant identity matching: stage 4.
- Consent records: stage 4 (taken during registration).
- Anonymization endpoints: stage 10.
- Group capacity and waitlists are configured now but enforced at
  registration (stage 4).
- Results are not stored yet: scoring and ranking run in simulation until
  attempts exist (stage 5) and result versions (stage 6).
