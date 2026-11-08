# Competition SaaS / Competition Operating System — Portable Project Memory

Last consolidated: 2026-10-04

## Purpose
This file is portable context for continuing the project with another AI model. It excludes personal/account identifiers and unrelated private information.

## 1. Product vision
Build a commercial, international, multi-tenant **Competition Operating System / Competition SaaS**, not a one-off event website.

Core model:
- Competition → Round → Group
- Content → Skill → Practice
- Judge → Audit → Publish

The system must let admins create many competitions with different groups, rules, UI, question formats, payment, scoring, qualification, analytics, certificates, etc., without rebuilding the product.

Inspired by reverse-engineering the public-facing competition flow of `www.nak.hk`, but with a new architecture, visual design, branding, and reusable engine.

## 2. Competition model
- Each competition can independently be free or paid.
- A student can participate in multiple competitions.
- Parent Account is separate and can manage multiple children.
- Students may also have their own login.
- School accounts are core/first-phase.
- School bulk registration is important.
- Groups initially include Kindergarten, Primary, Secondary, Open.
- Each Group can be toggled independently per Round.
- Each Competition → Round → Group can have completely different:
  - rules
  - UI
  - question formats
  - timing
  - scoring
  - ranking
  - qualification
  - attempt policy
- Competition supports multiple Rounds.
- Practice is separate from official competition.

## 3. Languages / international
Interface language and content language are independent.

Initial languages:
- English
- Traditional Chinese
- Simplified Chinese
- Thai

Architecture should support future languages, countries, timezones, currencies, tax, phone/address formats, payment providers, date/number formats.

Admin pages must support multilingual UI.

## 4. Multi-tenant SaaS
Structure:
Platform → Tenant/Organization → Competitions → Rounds → Groups

Each tenant has:
- admins
- competitions
- participants
- payments
- content banks
- branding/configuration
- certificates
- notifications
- analytics

Tenant data must be isolated.

Platform Super Admin can, according to permission:
- see/manage all tenants
- competitions
- participants
- payments
- AI logs
- anti-cheat logs
- audit logs
- suspend/disable/manage resources

High-privilege actions must be audit logged.

Privacy boundary:
- Student/Parent: own reports.
- School: own students/own competitions only.
- Competition Organizer: that competition only.
- Organizer/school does not automatically see a student's other competitions.
- Parent can see all children and relevant cross-tenant competitions on the same platform.
- Super Admin can see integrated cross-tenant view.

No custom domain in MVP.

## 5. Roles
Initial roles:
- Platform Admin
- Competition Admin
- School Admin
- Parent
- Student
- Judge
- Head Judge

Prototype permission concept:
- Platform Admin: all
- Competition Admin: competition, registration, content, payment, analytics, certificate, notifications
- School Admin: registration, students
- Parent: registration, students, certificate
- Student: students, play, certificate, ranking
- Judge: review, ranking
- Head Judge: review, ranking, certificate, analytics

Production authorization must be server-side; UI role hiding is not sufficient.

## 6. Student Identity / Learning Passport
Use **Platform-level Student Identity**.

Student has:
- unique Student ID
- separate login identity
- persistent identity across competitions/years

Learning Passport tracks:
- Mandarin proficiency
- English proficiency
- other configured languages/skills
- competition history
- skill development
- previous attempts
- practice recommendations
- pronunciation development

Core loop:
Competition → Attempt → Score → Skill Analysis → Weakness → Recommended Practice → Next Attempt → Progress

Comparison display is admin configurable:
- same competition
- same group
- age benchmark
- percentile
- previous attempt

Comparisons must be privacy-safe and aggregated.

Cross-tenant identity matching:
- never assume same person from name alone
- high-confidence matching may link
- otherwise separate profile/pending link
- no biometric matching in MVP

## 7. Registration / eligibility
Eligibility configurable by Competition Admin:
- age
- grade
- DOB
- combinations
- admin-defined cutoff date

Registration supports:
- capacity
- waitlist
- close date
- cancellation
- transfer
- refund
- amendment
- duplicate detection
- duplicate link/merge/admin resolution

Do not silently reject possible duplicates.

Parent flow:
Select child → Competition → Group eligibility → Language → Consent → Offer Code → Checkout → Receipt

School flow:
Roster → Student IDs → Competition/Group → Package seats → Submit

School bulk enrollment is core.

## 8. Competition versioning / live changes
Published/running competition should be versioned/locked but flexible enough for live incidents.

Normal:
- Planned Configuration Version

Emergency Override supports, for example:
- extend time
- disable question
- give points
- reopen attempt
- cancel round
- replace question
- invalidate attempt
- create make-up attempt

Every emergency action stores:
- actor
- time
- reason
- old value
- new value
- affected records
- audit log

Recalculation engine:
- recalculate score
- ranking
- qualification
- preserve old result
- store before/after

Official lifecycle:
Draft → Judge Review → Head Judge Approval → Published

Major later change:
Head Judge Override → New Result Version → Old Result Retained → Certificate Superseded/Reissued

## 9. Runtime / attempts
Attempt policy is Round-level:
- Qualifying: 1
- Final: 1
- Practice: unlimited
- configurable max attempts + best score

Practice never affects official ranking.

Timer:
- server-authoritative
- browser clock is not authoritative

Network:
- local autosave
- offline warning
- reconnect sync
- server timestamp
- short disconnect should not zero score
- longer disconnect may create Connection Anomaly

Browser refresh/close:
- resume from last saved state

Device:
- configurable 1 / 2 / unlimited devices
- suspicious switching flags review, not automatic cancellation

Make-up Attempt:
- original retained + invalidated
- new attempt becomes official

## 10. Anti-cheat
Required signals:
- random question order
- random answer order
- question pools
- session/device controls
- IP anomaly
- device/fingerprint signals
- tab switching
- fullscreen exit
- copy/paste
- screenshot-related signals where technically available
- timing anomaly
- answer-pattern anomaly
- impossible speed
- duplicate account signals
- concurrent sessions

Important: risk score is a review signal, not proof.

Workflow:
Normal → Flagged → Under Review → Cleared / Warning / Disqualified

Judge reviews; Head Judge makes final disqualification decision.

Fullscreen policy:
- Warning
- Pause
- Auto-submit

Copy/paste:
- Allow
- Block
- Flag

Emergency extension:
- authorized Head Judge
- e.g. +5 min
- record who/when/why/old/new

Question problem:
- Disable Question
- Give Everyone Full Credit
- Recalculate
- Replace Question

Affected participants automatically recalculate.

## 11. Content Bank
Question Bank is separate from Competition.

Questions are reusable across competitions. Competition references a **Content Bank Version**, not copied questions.

Stable fields:
- content_id
- content_type
- locale
- question
- options
- answer
- difficulty
- category
- tags
- media URLs
- explanation
- source/reference
- learning objective
- skill mapping
- version/status

Translations are separate from core question objects.

Difficulty:
- Easy
- Medium
- Hard
- Expert

Skill Framework is configurable. A question can map to one or more skills. Learning Objectives belong in Content Bank.

Supported question types:
1. Single Choice
2. Multiple Choice
3. True/False
4. Matching
5. Ordering
6. Image Choice
7. Audio Choice
8. Listen & Select
9. Text Input
10. Fill in Blank
11. Pronunciation/Speaking
12. Drag & Drop
13. Custom Question Type

Media:
- image
- audio
- video
- pronunciation recording
- explanation media
- source/reference

Excel bridge:
Download Template → Fill → Upload → Validate → Preview → Error Report → Publish Version → Competition references version

Per-content-type templates may be used.

## 12. Pronunciation / voice AI
Major feature.

Desired analysis:
- initials
- finals
- vowels
- tones
- tone combinations
- syllable accuracy
- fluency
- rhythm
- intelligibility
- phoneme-level analysis where feasible

Student results can use radar/spider visualizations and configurable comparisons:
- student
- group average
- age-group average
- previous attempt
- percentile

Language architecture should support:
- Mandarin
- English
- Cantonese
- Thai
- future languages

Use an **AI Provider Adapter** so provider/model can be swapped.

Do not hard-code one model.

Hugging Face/free models may be evaluated, but final model selection must consider current quality, licensing, cost, latency and deployment.

Voice retention default:
- analyze then delete raw voice
- competition can optionally retain e.g. 30/90 days if justified

If AI is unavailable:
- participant continues
- attempt saved
- mark AI_PENDING
- async retry

## 13. AI safety boundary
AI may generate only:
- score analysis
- approved skill strengths/weaknesses
- question explanations
- practice recommendations from approved Content Bank
- encouragement

AI may NOT:
- diagnose health/psychology/personality
- provide medical/legal/financial advice
- change official score
- change qualification
- decide disqualification
- recommend unknown external content
- conduct open-ended student chat
- accept unrelated PII

Pipeline:
AI output schema → validation → safety filter → display

Invalid output gets deterministic fallback.

Formal score/rank/qualification is deterministic or human controlled. AI never decides official outcomes.

## 14. Practice
Student gets:
- weak areas
- recommended questions
- automatically generated Practice Set

Initially use existing Content Bank.

Do not build full LMS in MVP.

Practice never affects official competition score/rank.

## 15. Judge / result governance
Judge:
- reviews ambiguous/suspicious cases
- submits recommendation

Head Judge:
- final approval
- official result override
- final disqualification
- certificate authority where configured

Hard rule:
**Official Result Override is Head Judge only.**

Result:
Draft → Judge Review → Head Judge Approval → Published

Every override is audited.

## 16. Ranking / qualification
Ranking scopes:
- individual
- group
- school
- country
- region
- class
- team

Team module should exist but stay simple in MVP.

Public leaderboard privacy modes:
A. Full name
B. First name + initial
C. Nickname
D. Student ID / anonymous code
E. Rank + score only

Recommended minor default: C or D.

Publication options:
- immediate
- after competition ends
- after Head Judge approval
- never

Default:
Head Judge approval → Published

Qualification engine is deterministic:
- top N
- percentage
- score threshold
- rank
- quotas
- wildcard
- manual override

Tie-breakers are ordered/configurable:
- total score
- accuracy
- time
- hard-question score
- earlier submission

AI never decides qualification.

## 17. Certificates
Automatic PDF certificates.

Design can vary by:
- competition
- category
- group

Lifecycle:
Result → Template → Generate → Deliver → Verify

Support:
- PDF
- QR
- verification ID
- public verification
- no-login verification

When result changes:
- old certificate = Superseded
- new certificate issued
- history retained
- QR points to current valid version

## 18. Notifications
Engine:
Trigger → Template → Language → Channel

Channels:
- Email
- SMS
- WhatsApp
- Push

Examples:
- registration confirmation
- payment confirmation
- competition reminder
- start reminder
- qualification
- final result
- certificate ready
- payment failed

Keep delivery logs.

## 19. Payment
Architecture is provider-independent.

Initial HK-oriented candidate:
**Airwallex**

Future providers can be added through adapters.

Parent flow:
Registration → Price → Offer Code → Discount → Tax → Final Amount → Payment Provider → Result → Receipt

Initial routing:
Parent → Tenant (Tenant is merchant)
Platform → SaaS fee

Architecture may later support split payments.

Competition has a fixed currency:
- HKD
- USD
- THB
- SGD
etc.

No dynamic FX checkout in MVP.

Tax:
- configurable architecture
- admin manual configuration initially

Offer Code MVP:
- code
- discount
- validity
- usage limit

Supports:
- trials
- festive discounts
- limited-time promotions
- scholarship / 100% discount
- invite code

School package:
- bulk enrollment
- online payment
- invoice
- bank transfer architecture
- purchase order architecture
MVP can focus on online payment + invoice.

Payment states:
- Pending
- Paid
- Failed
- Refunded
- Cancelled

Store:
- Order ID
- Payment ID
- Provider
- Currency
- Amount
- Discount
- Tax
- Refund
- timestamps
- webhook events

Never store card/CVV data. Use hosted checkout.

Refund:
- full
- partial
- admin initiated
- gateway reference
- reason
- audit

Receipt/invoice:
- email receipt
- PDF
- parent re-download
- admin search
- school package formal invoice

Payment reconciliation:
System Order ↔ Actual Gateway Transaction

Statuses:
- Matched
- Unsettled
- Mismatch

Platform economics:
Gross − Gateway Fee − Platform Fee = Tenant Net

## 20. SaaS plans / billing
Use:
Plan → Features → Limits → Tenant

Example plans:
- Starter
- Professional
- Enterprise

Possible limits:
- competitions
- admin users
- storage
- AI pronunciation minutes
- AI analysis volume
- questions
- schools
- email/SMS
- API calls

Separate:
- SaaS Billing ledger
- Competition Payment ledger

Subscription lifecycle:
- monthly
- annual
- trial
- upgrade
- downgrade
- cancel
- invoice
- payment failure
- grace period

AI usage:
- by tenant
- by competition
- estimated cost
- failed/pending jobs

Over-quota policy configurable:
- stop AI
- show upgrade
- allow additional credits

## 21. Privacy / data governance
Required:
- tenant isolation
- consent records
- audit logs
- data export
- deletion/anonymization
- retention
- backups
- restore
- minor-data safeguards

Student deletion:
- anonymize/delete PII where required
- retain legal/competition aggregate records where appropriate
Example: `Anonymous Participant #1842`

School must not see cross-tenant student competitions.

Parent can see all children and their relevant platform history.

## 22. Suggested production architecture
Frontend:
- multilingual web app
- responsive participant UI
- admin workspace
- school portal
- parent portal
- student Learning Passport
- judge/head judge workspace

Backend API:
- authentication
- authorization
- tenant isolation
- competition configuration
- versioning
- registrations
- attempts
- scoring
- qualification
- ranking
- certificates
- notifications
- payments
- audit
- privacy/data governance

Relational database preferred for transactional core.

Likely entities:
- tenants
- plans
- users
- roles
- permissions
- students
- parent-child relationships
- schools
- competitions
- competition_versions
- rounds
- groups
- round_group_configurations
- content_banks
- content_versions
- content_items/questions
- translations
- skills
- learning_objectives
- question_skill_mappings
- media
- registrations
- orders
- payments
- refunds
- webhook_events
- attempts
- attempt_answers
- anti_cheat_events
- risk_cases
- judge_reviews
- result_versions
- qualification_results
- rankings
- certificates
- certificate_versions
- notification_templates
- notification_deliveries
- practice_sets
- practice_attempts
- ai_jobs
- ai_results
- ai_usage
- audit_logs
- consent_records
- retention_policies

Object storage:
- question media
- audio/video
- retained voice recordings
- certificates
- exports

Background queue:
- pronunciation AI
- certificate generation
- notifications
- payment webhook processing
- reconciliation
- recalculation
- analytics
- retries

Security:
- secure authentication
- server-side authorization
- tenant isolation
- verified/idempotent payment webhooks
- rate limiting
- CSRF/XSS protection
- upload validation
- encryption where appropriate
- secrets manager
- backups
- restore testing
- deletion/anonymization
- consent tracking

## 23. MVP: deliberately defer complexity
Keep first release simple.

Defer/minimize:
- custom domains
- complex SSO
- complex team hierarchy
- full LMS
- adaptive learning engine
- many payment providers
- complex identity verification
- AI as official result authority
- complex tenant-to-tenant sharing

Architecture should remain extensible.

## 24. Current prototype
Saved Site Preview:
- Name: `QuizFlow Competition Engine Prototype.html`
- Library file ID: `libfile_aac53fa8417c8191af112934668ccb81`
- Current version: 6
- Preview ID: `902e21f2-3f32-4716-a12f-e0bc37f02a09`
- Source message ID: `e04df5b8-899a-4ec6-8269-08517108c47a`

Current prototype pages/modules:
- Overview
- Competition
- Registration
- Parameters
- Content Bank
- Students / Learning Passport
- Payments / Reconciliation
- Review / Integrity
- Analytics
- Notifications
- Certificates
- Billing
- Participant
- Leaderboard

Prototype also demonstrates:
- locale selector
- role selector
- role-aware navigation/permission simulation
- localStorage state
- audit simulation
- official result override simulation
- certificate verification
- certificate issuing simulation
- registration creation simulation
- notification creation simulation
- payment reconciliation simulation
- answer autosave simulation

Runtime state key:
`quizflow_platform_state_v1`

Prototype is **not production backend**. Do not claim it has:
- real database
- real authentication
- live payment gateway
- production AI inference
- production notifications
- production certificate generation
- production cloud storage
- production security

It is a browser/localStorage front-end product prototype.

## 25. Build roadmap
1. Product foundation: DB/auth/tenants/roles/permissions
2. Competition engine: competitions/versions/rounds/groups/rules/eligibility/attempts/scoring/qualification
3. Content engine: content bank/skills/objectives/translations/media/difficulty/Excel/versioning
4. Registration/payment: parent/school registration/pricing/offers/tax/checkout/receipts/refunds/reconciliation/webhooks
5. Competition runtime: server timer/autosave/reconnect/resume/anti-cheat/device/session
6. Judge/results: review/Head Judge approval/override/emergency actions/result versions/recalculation/publication
7. Learning Passport + AI: longitudinal skills/pronunciation/AI queue/validation/practice
8. Certificates + notifications
9. SaaS commercial layer: plans/limits/subscriptions/platform fees/AI cost
10. Privacy/internationalization
11. Production deployment/testing/monitoring/backups/security review

## 26. Inputs needed for real production launch
Requirements are sufficiently defined; avoid repeating product questions.

Operational inputs:
- legal company name
- operating country
- support email
- privacy policy
- terms
- refund policy
- retention policy
- merchant/payment entity

Payment:
- merchant account
- API credentials
- webhook configuration
- settlement configuration
- refund permissions
Never paste secret API keys into chat.

AI:
- selected production provider/model
- credentials
- expected volume
- cost budget
- voice retention decision
Model selection should be researched before final commitment.

First real competition dataset:
- name
- date/time/timezone
- groups
- rounds
- question count/types
- timing
- scoring
- qualification
- fees
- currency
- languages
- certificates
- pronunciation settings where relevant

Test roles:
- Platform Admin
- Competition Admin
- School Admin
- Parent
- Student
- Judge
- Head Judge

## 27. Hard rules to preserve
1. Competition fee can be free/paid independently.
2. Student can join multiple competitions.
3. Parent can manage multiple children.
4. Groups can have different rules/UI/question formats.
5. Interface/content languages are independent.
6. Competition supports multiple rounds.
7. Each round can have different rules.
8. Published competition uses versioning + emergency override.
9. Emergency changes require reason + audit.
10. Recalculation preserves before/after results.
11. Content Bank is reusable and separately versioned.
12. Difficulty is configurable.
13. Translations are separate.
14. Pronunciation AI is provider/model swappable.
15. Human judge workflow is required.
16. Official Result Override = Head Judge only.
17. Qualification is deterministic.
18. AI cannot change official score/rank/qualification.
19. Anti-cheat risk is a signal, not proof.
20. Practice never affects official results.
21. Student identity persists across years.
22. School access stays scoped.
23. Parent can see all children/relevant competitions.
24. Public leaderboard privacy is configurable.
25. Certificate reissue supersedes old version; history retained.
26. Payment provider is abstracted.
27. Airwallex is the initial HK-oriented candidate.
28. Tenant is merchant; platform charges SaaS fee initially.
29. Competition currency is fixed.
30. Payment reconciliation is a dedicated feature.
31. AI usage/cost is tracked.
32. Deletion/anonymization must protect PII.
33. Raw voice should normally be deleted after analysis unless retention enabled.
34. International architecture from the start.
35. Keep MVP simple and operationally practical.

## 28. Working style / project instruction
The user has explicitly indicated that the requirements are sufficiently defined and prefers the assistant to **stop asking repeated product questions and proceed using accumulated decisions**.

When something is unspecified:
- make a sensible production architecture choice
- keep it modular
- keep MVP simple
- preserve future extensibility
- explain material trade-offs
- do not block progress with unnecessary questions
