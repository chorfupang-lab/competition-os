/**
 * Integrity signals and risk score. A risk score is a REVIEW SIGNAL, never
 * proof (hard rule 19): above the threshold a case opens as "flagged" for a
 * judge; nothing is cancelled or penalized automatically.
 */
export const CLIENT_EVENT_TYPES = [
  "tab_hidden", "window_blur", "fullscreen_exit", "fullscreen_enter", "copy", "cut", "paste", "context_menu",
  "screenshot_key", "devtools_open", "offline", "online", "resize",
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

export const SERVER_EVENT_TYPES = [
  "device_switch", "device_limit_exceeded", "concurrent_session", "ip_change", "connection_gap", "late_sync",
  "impossible_speed", "answer_similarity", "answer_pattern", "shared_device", "auto_submitted_policy",
] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type IntegrityEventType = ClientEventType | ServerEventType;

interface Weight { points: number; cap: number }

const WEIGHTS: Partial<Record<IntegrityEventType, Weight>> = {
  tab_hidden: { points: 3, cap: 15 },
  window_blur: { points: 1, cap: 5 },
  fullscreen_exit: { points: 5, cap: 20 },
  copy: { points: 3, cap: 9 },
  cut: { points: 3, cap: 9 },
  paste: { points: 8, cap: 24 },
  screenshot_key: { points: 10, cap: 20 },
  devtools_open: { points: 15, cap: 15 },
  device_switch: { points: 10, cap: 20 },
  device_limit_exceeded: { points: 15, cap: 15 },
  concurrent_session: { points: 15, cap: 30 },
  ip_change: { points: 5, cap: 10 },
  connection_gap: { points: 5, cap: 15 },
  late_sync: { points: 5, cap: 10 },
  impossible_speed: { points: 20, cap: 20 },
  answer_similarity: { points: 25, cap: 25 },
  answer_pattern: { points: 10, cap: 10 },
  shared_device: { points: 15, cap: 15 },
};

export const RISK_FLAG_THRESHOLD = 30;

export interface RiskSignal {
  type: IntegrityEventType;
  count: number;
  points: number;
}

/**
 * Deterministic risk score (0–100). Copy/paste counts only when the round's
 * policy is "flag"; with "allow" it is ignored, with "block" the browser
 * prevents it and any attempt to do so is still counted.
 */
export function riskScore(events: ReadonlyArray<{ type: string }>, policy: { copyPaste: "allow" | "block" | "flag" }): { score: number; signals: RiskSignal[] } {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const signals: RiskSignal[] = [];
  for (const [type, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (policy.copyPaste === "allow" && (type === "copy" || type === "cut" || type === "paste")) continue;
    const w = WEIGHTS[type as IntegrityEventType];
    if (!w) continue;
    signals.push({ type: type as IntegrityEventType, count, points: Math.min(w.cap, w.points * count) });
  }
  return { score: Math.min(100, signals.reduce((s, x) => s + x.points, 0)), signals };
}

export interface AnswerFact {
  itemId: string;
  /** Normalized response, e.g. JSON of the response object. */
  response: string;
  correct: boolean;
  timeSpentMs: number;
  /** Position of the chosen option as displayed (choice questions), else null. */
  displayedPosition: number | null;
}

export const MIN_HUMAN_MS_PER_QUESTION = 1500;

/** Many correct answers faster than a person can read the question. */
export function detectImpossibleSpeed(answers: readonly AnswerFact[]): { fast: number; total: number } | null {
  const fastCorrect = answers.filter((a) => a.correct && a.timeSpentMs > 0 && a.timeSpentMs < MIN_HUMAN_MS_PER_QUESTION).length;
  return fastCorrect >= 3 && fastCorrect >= answers.length * 0.3 ? { fast: fastCorrect, total: answers.length } : null;
}

/** The same displayed position for (nearly) every choice question: answering without reading. */
export function detectAnswerPattern(answers: readonly AnswerFact[]): { position: number; share: number } | null {
  const positions = answers.map((a) => a.displayedPosition).filter((p): p is number => p !== null);
  if (positions.length < 8) return null;
  const freq = new Map<number, number>();
  for (const p of positions) freq.set(p, (freq.get(p) ?? 0) + 1);
  const [position, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
  return n / positions.length >= 0.9 ? { position, share: Math.round((n / positions.length) * 100) / 100 } : null;
}

/**
 * Shared wrong answers with another attempt on the same questions. Matching
 * correct answers prove nothing; matching the same wrong answers is the
 * classic collusion signal.
 */
export function detectAnswerSimilarity(mine: readonly AnswerFact[], other: readonly AnswerFact[]): { sharedWrong: number; myWrong: number } | null {
  const theirs = new Map(other.filter((a) => !a.correct).map((a) => [a.itemId, a.response]));
  const myWrong = mine.filter((a) => !a.correct);
  const sharedWrong = myWrong.filter((a) => theirs.get(a.itemId) === a.response).length;
  return sharedWrong >= 5 && sharedWrong >= myWrong.length * 0.5 ? { sharedWrong, myWrong: myWrong.length } : null;
}
