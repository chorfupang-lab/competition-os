# Competition runtime: client contract

How the participant app (built later) must talk to the runtime API. The
server is authoritative for time, attempts and scoring. The browser only
renders the attempt, saves answers, and reports what happens on the page.

## Flow

1. `GET /me/rounds?studentId=…` lists rounds with `state`
   (upcoming / open / closed), attempts used and left, and any running
   attempt.
2. `POST /me/attempts { registrationId, roundId, deviceId, fingerprint? }`
   starts an attempt, or resumes the running one.
   - `deviceId` is a random id kept in `localStorage`.
   - `fingerprint` is an optional hash of stable browser traits.
   - The response holds `sessionId`, `attempt` (with `deadlineAt`,
     `serverTime`, `remainingSeconds`), `policy`, `questions` (no answers)
     and saved `answers`.
3. Show the timer from `deadlineAt − serverTime`, re-synced on every
   response. Never use the device clock alone.
4. Autosave with `PUT /me/attempts/:id/answers { sessionId, answers: [...] }`.
   - Each answer carries a per-question `clientSeq` that increases with
     every change, plus `clientSavedAt` and `timeSpentMs`.
   - Keep unsent answers in local storage while offline, and send them in
     one batch on reconnect.
   - The server keeps the highest `clientSeq` per question and returns
     `saved` and `rejected` with reasons:
     - `stale`: a newer answer is already saved;
     - `after_deadline`: arrived too late;
     - `not_in_attempt`: the question is not part of this attempt;
     - `client_time_invalid`: the device clock is implausible.
5. `POST …/heartbeat { sessionId }` every ~15 s. Show an offline warning
   when a call fails.
6. `POST …/events { sessionId, events: [{ type, at }] }` reports page
   events: `tab_hidden`, `window_blur`, `fullscreen_exit` /
   `fullscreen_enter`, `copy` / `cut` / `paste`, `context_menu`,
   `screenshot_key`, `devtools_open`, `offline` / `online`, `resize`.
   The response's `action` is one of:
   - `warn`: show a warning;
   - `pause`: hide the questions until fullscreen returns, then call
     `POST …/resume` (the timer keeps running);
   - `submitted`: the attempt was closed under the round's policy.
7. `POST …/submit { sessionId }`. The response shows a provisional score
   only if the round's `ui.showScoreOnSubmit` is on.

Refreshing the page, closing it, or losing connection never loses saved
answers. `GET /me/attempts/:id?sessionId=…` returns the full state.

## Rules the server applies

| Situation | Behaviour |
|---|---|
| Deadline | `min(start + duration + extensions, round close)`. |
| Late arrival | Accepted up to 10 s after the deadline (network grace). |
| Offline answers | Accepted up to 2 min after the deadline if `clientSavedAt` is before it; flagged `late_sync`. |
| After that | The attempt is auto-submitted, on next access or by the worker. |
| Silence over 60 s | `connection_gap` signal (Connection Anomaly). A short disconnect never zeroes a score. |
| New device beyond `maxDevices` | Refused with `device_limit`; the attempt continues on the allowed device; signal recorded. |
| New device within the limit | The older session is superseded (its saves get `session_superseded`); `device_switch` or `concurrent_session` recorded. |
| Same device or fingerprint used by another student in the round | `shared_device` signal. |
| IP change | `ip_change` signal. |
| Copy/paste | `allow`: ignored for risk; `block`: the browser prevents it (attempts still reported); `flag`: counted. |
| On submit | Server checks for impossible speed, one-position answering, and wrong answers shared with another student. |

The risk score (0–100, deterministic weights in
`packages/core/src/runtime/integrity.ts`) is a review signal only. At 30 or
more, a risk case opens as `flagged` for judges. Nothing is cancelled or
penalized automatically. Judges review in stage 6, and only a Head Judge
disqualifies.

## Questions

Each attempt stores its seed and its frozen question set: the items and the
display order of their options or parts. It can be rebuilt exactly for
review. Parts whose stored order would reveal the answer (ordering items,
matching right column, drag-and-drop pieces) are always shuffled. Option
order follows `randomizeOptions`.
