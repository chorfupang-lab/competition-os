# AI, pronunciation and the Learning Passport

## Boundaries (requirements section 13)

AI in this platform may only produce:
- pronunciation **measurements**;
- **score analysis** and **approved** skill strengths and weaknesses;
- **practice recommendations** from practice-enabled content banks;
- **encouragement**.

It never changes an official score, rank, qualification or disqualification
(HR18), never diagnoses, never gives medical, legal or financial advice,
never links outside content, and never opens a chat.

| Where AI is involved | What decides |
|---|---|
| Official pronunciation question | The AI measures; a deterministic rubric suggests a grade; **a judge confirms it** (per attempt, or in bulk for a round). Until then the attempt is `pending_manual`, and results can't be approved. |
| Practice pronunciation | The AI suggestion is used directly. Practice is unofficial. |
| Feedback text | The AI phrases pre-computed facts. Output is schema-checked, reference-checked and safety-filtered; anything invalid is replaced by deterministic template text. |

## Pipeline

```
recording upload ──► answer saved at once (attempt continues) ──► ai_jobs (queued)
                                                                     │
worker: lease ──► provider.assess() ──► schema validate ──► assessment + suggested grade
                                                                     │
          raw voice deleted (or retained 30/90 days with a reason) ◄─┘
          attempt re-scored (pending_manual) ──► judge confirms ──► scored

feedback request ──► facts (score, framework skills, practice items) ──► provider.generate()
          ──► schema ──► only provided ids? ──► safety filter ──► show
                                             └── any failure ──► deterministic fallback (4 locales)
```

- **Jobs** are leased (`FOR UPDATE SKIP LOCKED`), so several workers are
  safe. Failures retry with exponential backoff, up to 5 attempts. A
  provider outage never blocks a participant: answers are saved, the attempt
  shows AI pending, and judges can grade by hand at any time.
- **Rejected AI output** is audited (`ai.feedback_rejected`, with the
  reasons).

## Providers (swappable, HR14)

| Kind | Implementations | Configuration |
|---|---|---|
| Pronunciation | `mock` (deterministic; development and tests), `http` (any service implementing the contract below) | `PRONUNCIATION_URL`, `PRONUNCIATION_TOKEN` |
| Feedback text | `template` (default, no LLM), `anthropic` (Claude via the official SDK) | `AI_FEEDBACK_PROVIDER=anthropic`, `AI_FEEDBACK_MODEL` (default `claude-opus-5-5`), Anthropic credentials from the environment |

The Claude adapter requests JSON output against a JSON schema, at `low`
effort, with server-side refusal fallbacks enabled (`fallbacks: "default"`).
A refusal, or output that won't parse, falls back to the template text.

**Pronunciation HTTP contract.** This lets us use a self-hosted open model
or a vendor API behind a thin proxy. We haven't committed to a model; it
must be evaluated for quality, licensing, cost and latency per language:
`cmn` (Mandarin), `yue` (Cantonese), `en`, `th`.

```
POST {PRONUNCIATION_URL}
{ "audioBase64": "...", "mimeType": "audio/webm", "targetText": "你好", "speechLanguage": "cmn",
  "romanization": "nǐ hǎo", "aspects": ["tones", "finals"] }
→ 200
{ "overall": 0-100, "aspects": { "tones": 0-100, ... }, "units": [{ "text": "你", "score": 0-100, "expected": "3", "heard": "2" }],
  "durationMs": 1800, "model": "provider-model-id" }
```

The rubric (`suggestedFraction` in `packages/core/src/ai/pronunciation.ts`)
works like this:
- it averages the item's configured aspects;
- 85 or more counts as full credit, 40 or less as zero, and linear in
  between;
- an aspect the provider doesn't report falls back to the overall score.

## Voice retention

- The default is **analyse, then delete** the raw recording.
- A competition can keep recordings for 30 or 90 days
  (`PATCH .../ai-settings`, reason required, audited). The worker deletes
  them when retention ends.
- Practice recordings are always deleted after analysis.

## Learning Passport

`GET /me/passport/:studentId` (the student, or their parent) covers every
organizer the student has taken part with:
- **Skills.** Recency-weighted mastery per skill (official evidence counts
  double), with a trend and the latest change, plus strengths and weak areas
  (weak areas need at least 3 questions of evidence).
- **History.** Published results, plus the comparisons the organizer turned
  on: group average, percentile, age benchmark, previous attempt.
  Comparisons are aggregates and are **hidden for cohorts under 10**.
- **Pronunciation.** Per speech language: latest vs previous aspects (the
  radar-chart data), the group average when the cohort allows, and a trend.
- **Recommended practice.** Items for the weak skills, from
  **practice-enabled banks only**.

## Practice

- `POST /me/practice-sets` builds a set for the student's weakest skills,
  from the latest version of a practice-enabled bank.
  `/submit` grades it at once; pronunciation questions use the AI suggestion
  when it has arrived.
- Practice is stored separately from attempts and results (HR20) and feeds
  the Passport as `practice` evidence.
- Banks used for live competitions should **not** be practice-enabled.
  Otherwise competition questions leak into practice.

## Usage and cost

`ai_usage` records every provider call: kind, provider, model, units
(audio ms or tokens) and estimated cost. `GET /t/:tenantId/ai/usage`
reports totals and job health (pending, failed). Quotas and over-quota
policy come with SaaS plans (stage 9).
