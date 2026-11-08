/**
 * Server-authoritative timing. The browser clock never decides anything.
 *
 *   deadline = min(start + duration + extensions, round closes)
 *   Answers arriving up to NETWORK_GRACE after the deadline count normally.
 *   Answers the client saved offline before the deadline are accepted up to
 *   OFFLINE_SYNC_GRACE after it, and flagged ("late_sync") for review.
 *   A silence longer than CONNECTION_GAP is a Connection Anomaly signal.
 */
export const NETWORK_GRACE_MS = 10_000;
export const OFFLINE_SYNC_GRACE_MS = 120_000;
export const CONNECTION_GAP_MS = 60_000;
export const CLOCK_SKEW_MS = 5_000;

export function attemptDeadline(startedAt: Date, durationSeconds: number, extensionSeconds: number, roundClosesAt: Date): Date {
  return new Date(Math.min(startedAt.getTime() + (durationSeconds + extensionSeconds) * 1000, roundClosesAt.getTime()));
}

export function remainingSeconds(deadline: Date, now: Date): number {
  return Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000));
}

export type SaveDecision = { accept: true; late: boolean } | { accept: false; reason: "after_deadline" | "client_time_invalid" };

export function decideAnswerSave(o: { now: Date; deadline: Date; startedAt: Date; clientSavedAt: Date | null }): SaveDecision {
  const now = o.now.getTime();
  const deadline = o.deadline.getTime();
  const client = o.clientSavedAt?.getTime() ?? null;
  if (client !== null && (client > now + CLOCK_SKEW_MS || client < o.startedAt.getTime() - CLOCK_SKEW_MS)) return { accept: false, reason: "client_time_invalid" };
  if (now <= deadline + NETWORK_GRACE_MS) return { accept: true, late: false };
  if (client !== null && client <= deadline && now <= deadline + OFFLINE_SYNC_GRACE_MS) return { accept: true, late: true };
  return { accept: false, reason: "after_deadline" };
}

/** True once the attempt can no longer receive answers and should be auto-submitted. */
export function isPastDeadline(deadline: Date, now: Date): boolean {
  return now.getTime() > deadline.getTime() + OFFLINE_SYNC_GRACE_MS;
}
