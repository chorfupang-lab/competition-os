import { compareParticipants, type RankInput, type TieBreaker } from "./ranking.ts";

/**
 * Attempt policy (round-level). Practice rounds use maxAttempts = null
 * (unlimited) and never feed official rankings.
 *
 * Make-up attempts: the original stays on record as invalidated, and an
 * admin-granted make-up adds one extra attempt, which then becomes official.
 */
export interface AttemptPolicy {
  /** null = unlimited */
  maxAttempts: number | null;
  counting: "best" | "latest" | "first";
}

export interface AttemptRecord extends Omit<RankInput, "participantId" | "status" | "scopes"> {
  attemptId: string;
  status: "in_progress" | "submitted" | "invalidated";
}

export function remainingAttempts(policy: AttemptPolicy, attemptsStarted: number, makeUpGrants = 0): number | null {
  if (policy.maxAttempts === null) return null;
  return Math.max(0, policy.maxAttempts + makeUpGrants - attemptsStarted);
}

/** The attempt that counts officially, or null if none is submitted and valid. */
export function selectOfficialAttempt(
  attempts: readonly AttemptRecord[],
  policy: AttemptPolicy,
  tieBreakers: readonly TieBreaker[],
): AttemptRecord | null {
  const valid = attempts.filter((a) => a.status === "submitted");
  if (valid.length === 0) return null;
  const byTime = [...valid].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || (a.attemptId < b.attemptId ? -1 : 1));
  if (policy.counting === "first") return byTime[0]!;
  if (policy.counting === "latest") return byTime[byTime.length - 1]!;
  const asRank = (a: AttemptRecord): RankInput => ({ ...a, participantId: a.attemptId, status: "ok" });
  // Best by the round's tie-breakers, ignoring "earlier_submission" across a
  // participant's own attempts; equal attempts resolve to the earliest.
  const tbs = tieBreakers.filter((t) => t !== "earlier_submission");
  return [...byTime].sort((a, b) => compareParticipants(asRank(a), asRank(b), tbs))[0]!;
}
