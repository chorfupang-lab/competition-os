# Judging, results and emergency actions

## Who can do what

| Action | Competition Admin | Judge | Head Judge | Platform Admin |
|---|:-:|:-:|:-:|:-:|
| Compute draft results, submit for review | ✓ | | ✓ | ✓ (tenant-level) |
| Review results (approve / changes requested) | | ✓ | ✓ | |
| **Approve & publish official results** | | | **✓ only** | |
| **Result overrides** (score correction, qualification wildcard/exclusion) | | | **✓ only** | |
| Review integrity cases, recommend, clear, warn | | ✓ | ✓ | |
| **Disqualify** | | | **✓ only** | |
| Grade pending questions (custom; pronunciation fallback) | | ✓ | ✓ | |
| **Re-grade an already graded answer** | | | **✓ only** | |
| **Emergency actions** | | | **✓ only** | |
| Results publication and leaderboard privacy settings | ✓ | | | ✓ |

The Platform Admin never holds Head Judge powers (hard rule 16). If they must
act, they grant themselves Head Judge in that tenant, and that grant is
audited.

## Result lifecycle

```
compute ──► draft ──submit──► in_review ──judge approves──► (Head Judge) approve ──► published
              ▲                    │                                                  │
              └─ changes requested ┘            a later change → new version ──► previous: superseded
```

- **Every computation is a new version.** Each version stores an immutable
  snapshot of every entry (score, rank, scope ranks, qualification and
  basis), the inputs used (overrides, question adjustments, attempt ids),
  and a **before/after diff** against the published version.
- **Approval is blocked** while:
  - the round is still open, or a make-up window is still running;
  - an attempt is still running, or grading is pending (AI or manual);
  - an integrity case is flagged or under review;
  - no judge has approved the version;
  - the attempts changed since the version was computed (recompute first).
- **Approval publishes.** The previous published version becomes
  `superseded` and is kept.
- **Head Judge overrides** carry forward into later recomputations until
  replaced. Score overrides keep the original score alongside.
- **Qualification is deterministic** (stage 2 engine) and gates the next
  round: only participants marked qualified in the source round's
  *published* results can start a qualified-entry round.

## Emergency actions

All are recorded in `emergency_actions` with actor, time, reason, before,
after and the affected records, and in the audit log.

| Action | Effect |
|---|---|
| `extend-time` | Adds seconds to running attempts (all in a round, a group, or chosen ones). The deadline may pass the round close by the same amount. |
| `reopen-attempt` | A submitted attempt runs again for N seconds; its previous score goes into history. |
| `invalidate-attempt` | Kept on record, never counts. Existing results are recomputed. |
| `makeup-attempt` | The original is invalidated and kept. One extra attempt is granted, usable for N hours even after the round has closed. |
| `questions` → `disable` | Removed from every attempt's score and maximum. New attempts don't get it. |
| `questions` → `full_credit` | Everyone gets full points for it. |
| `questions` → `replace` | Removed from scoring. New attempts get the replacement item. |
| `cancel-round` | All attempts invalidated; the round can no longer be started or have results approved. |

Question fixes re-score every affected submitted attempt. The previous score
is kept in `attempt_score_history`, and existing results are recomputed as
new draft versions (`trigger: recalculation`) that go through review again.

## Publication and leaderboards

- `resultsPublication`: `on_approval` (default), `after_competition_ends`
  (public once the last round closes), or `never`. `never` means official
  results exist for the organizer, but there is no leaderboard and families
  don't see them.
- `leaderboardPrivacy`: `full_name`, `first_name_initial`, `nickname`
  (default), `anonymous_code` or `rank_score_only`. A missing nickname falls
  back to the anonymous code. The anonymous code is per competition, and the
  platform Student ID is never shown publicly.
- `liveLeaderboard` ("immediate"): a provisional board from the latest
  unpublished computation, clearly marked `provisional`.
- Judges without tenant-wide student access review results **blind**: they
  see anonymous codes instead of names.
