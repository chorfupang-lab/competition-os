# Roadmap

| # | Stage | Status |
|---|---|---|
| 1 | **Product foundation**: DB, auth, tenants, roles, permissions, isolation, schools/rosters, parents/children, audit | ✅ Done |
| 2 | **Competition engine**: competitions, config versions, rounds, groups, per-round-group rules, eligibility, attempt policy, scoring, ranking, qualification | ✅ Done |
| 3 | **Content engine**: content banks and versions, items, translations, skills, learning objectives, media, difficulty, Excel import | ✅ Done |
| 4 | **Registration and payment**: parent/school registration, pricing, offer codes, tax, Airwallex hosted checkout, webhooks, receipts, refunds, reconciliation | ✅ Done (Airwallex sandbox check pending) |
| 5 | Competition runtime: server timer, autosave/resume, devices/sessions, anti-cheat signals | Next |
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

## Stage 3 — what is in place

- Skill frameworks per tenant, hierarchical; a bank uses one framework.
- Content banks with a base locale and the locales they require.
- Learning objectives belong to a bank.
- Items cover all 13 question types. Each has a strict schema with
  cross-checks: the answer must be one of the options, every blank must
  appear in the prompt, image choices need images, and so on. Each item
  also carries difficulty, points, category, tags, skills, objectives,
  https media, explanation and source. Edits use revision checks.
- Status is draft / ready / retired, and retiring needs a reason.
- Deterministic answer checking for every type:
  - text answers ignore full-width/half-width differences, case and
    trailing punctuation, and can optionally ignore spaces (useful for CJK);
  - partial credit for multiple choice, matching, ordering, fill-in-the-blank
    and drag-and-drop;
  - pronunciation goes to AI (pending) and custom items to manual grading.
- Translations are stored apart from items. Only display text is
  translatable, never answers or pronunciation targets. A translation is
  marked stale when the source text changes, and approval requires every
  text to be translated.
- Excel import:
  - a template with a sheet for each question type plus a translations
    sheet, with example rows and dropdowns;
  - upload validates and previews (create / update / unchanged) with
    row-level errors, and nothing changes until commit;
  - commit re-validates against the current bank.
- Publishing a version snapshots the ready items, their current approved
  translations, and their skill and objective keys. A version is immutable
  (database trigger plus grants).
- Competitions reference a version id. Saving or publishing checks that
  the version exists in the tenant and that the items matching each
  round-group's question formats and filters cover its question count, and
  warns about missing translations.
- 152 tests in total.

## Stage 4 — what is in place

- **Parent flow:** child → competition → group eligibility → language →
  consent → offer code → checkout → receipt. A quote endpoint shows the
  outcome before anything is written.
- **School flow:** roster → Student IDs → competition and group → seats →
  submit. It has a dry-run preview, per-student problem reports, a consent
  attestation, and invoice or online payment.
- **Registration rules:**
  - registration window, and private competitions closed to parents;
  - invite-only competitions need an invite code;
  - eligibility is checked with the declared or roster grade, and only
    offered content languages are accepted;
  - one live registration per student per competition;
  - possible duplicate people are flagged, never rejected, and an admin
    resolves them.
- **Capacity:** seat holds for unpaid registrations, a waitlist with
  automatic promotion, and late payments that never lose money. Concurrent
  registrations are serialized per competition.
- **Prices:** per group, with early-bird windows. Tax is inclusive or
  exclusive. Offer codes are percent or fixed, with validity windows, total
  and per-user limits, and are scoped to a competition or the whole tenant;
  100% scholarships are supported.
- **Orders:** sequential order numbers per tenant, per-line discount and
  tax (fixed discounts spread to the cent), and the platform fee recorded on
  each order.
- **Payment provider adapter:**
  - Airwallex adapter written, awaiting a sandbox check;
  - an Airwallex-compatible test gateway;
  - signed and idempotent webhooks, checked against the raw body with
    replay protection;
  - gateway outages leave seats held and checkout retryable.
- **Refunds:** full or partial, with a reason. They cancel the listed
  registrations and promote the waitlist. A refund settles by webhook, and a
  failed refund can be retried.
- **Admin actions:** cancel, change group (eligibility and capacity
  re-checked, prices must match), transfer to another student, and mark an
  invoice paid. Each requires a reason and is audited.
- **Receipts and invoices:** HTML in all four locales.
- **Reconciliation and economics:**
  - reconciliation reports matched, unsettled and mismatch, from an
    imported settlement report or a provider sync;
  - the economics summary gives gross, gateway fee, platform fee, refunds
    and tenant net.
- **Consent records:** append-only, with the consent version and a hash of
  the text agreed.
- 183 tests in total.

## Known gaps carried forward

- Email verification, password reset, invitations: stage 8 (notifications).
  Registration, payment and waitlist-offer emails are also stage 8; the
  events already exist in the audit log.
- Receipts are HTML. PDF receipts with embedded CJK and Thai fonts come with
  the certificate engine (stage 8), which uses the same renderer approach.
- Hold expiry and waitlist promotion run whenever a registration or admin
  listing touches the competition. A scheduled sweep arrives with the job
  queue (stage 5).
- Claiming an existing student (a parent linking to a school-created
  identity) needs a verified pending-link workflow; scheduled for stage 10
  with data governance.
- Anonymization endpoints: stage 10.
- Group capacity and waitlists are configured now but enforced at
  registration (stage 4).
- Media are https links for now. Uploads to object storage, with type and
  size checks, come with production storage (stage 11). Raw voice
  recordings are handled in stage 7.
- Questions are picked per participant at runtime (stage 5). The pool
  check exists now.
- Results are not stored yet: scoring and ranking run in simulation until
  attempts exist (stage 5) and result versions (stage 6).
