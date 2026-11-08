/**
 * Scoring: turns graded items (from the runtime, stage 5) into an attempt
 * summary. Deterministic: results are rounded to 3 decimal places so the same
 * answers always produce exactly the same score.
 *
 * `adjustment` carries emergency actions (stage 6): a disabled question is
 * removed from the attempt entirely; full_credit awards everyone full points.
 */
export const DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface ScoringRule {
  /** "item" uses each question's own points from the content bank. */
  correctPoints: "item" | number;
  /** Zero or negative (negative marking). */
  incorrectPoints: number;
  unansweredPoints: number;
  partialCredit: "none" | "proportional";
  difficultyMultipliers: Record<Difficulty, number>;
  floorAtZero: boolean;
}

export const DEFAULT_SCORING_RULE: ScoringRule = {
  correctPoints: "item",
  incorrectPoints: 0,
  unansweredPoints: 0,
  partialCredit: "none",
  difficultyMultipliers: { easy: 1, medium: 1, hard: 1, expert: 1 },
  floorAtZero: true,
};

export interface GradedItem {
  itemId: string;
  maxPoints: number;
  difficulty: Difficulty;
  outcome: "correct" | "incorrect" | "partial" | "unanswered";
  /** 0..1 for partial outcomes. */
  fraction?: number;
  timeMs?: number;
  adjustment?: "disabled" | "full_credit";
}

export interface AttemptScore {
  totalScore: number;
  maxScore: number;
  correctCount: number;
  incorrectCount: number;
  partialCount: number;
  unansweredCount: number;
  /** Correct answers (partials by fraction) over scored items, 0..1. */
  accuracy: number;
  /** Points from hard and expert questions; a common tie-breaker. */
  hardQuestionScore: number;
  timeMs: number;
  items: Array<{ itemId: string; points: number; maxPoints: number; excluded: boolean }>;
}

export const round3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function scoreAttempt(items: GradedItem[], rule: ScoringRule): AttemptScore {
  let total = 0;
  let max = 0;
  let hard = 0;
  let correctUnits = 0;
  let scored = 0;
  let time = 0;
  const counts = { correct: 0, incorrect: 0, partial: 0, unanswered: 0 };
  const out: AttemptScore["items"] = [];

  for (const item of items) {
    const base = (rule.correctPoints === "item" ? item.maxPoints : rule.correctPoints) * rule.difficultyMultipliers[item.difficulty];
    if (item.adjustment === "disabled") {
      out.push({ itemId: item.itemId, points: 0, maxPoints: 0, excluded: true });
      continue;
    }
    scored += 1;
    max += base;
    time += item.timeMs ?? 0;
    let points: number;
    let units: number;
    if (item.adjustment === "full_credit") {
      points = base;
      units = 1;
      counts.correct += 1;
    } else {
      counts[item.outcome] += 1;
      switch (item.outcome) {
        case "correct":
          points = base;
          units = 1;
          break;
        case "partial": {
          const f = Math.min(1, Math.max(0, item.fraction ?? 0));
          units = f;
          points = rule.partialCredit === "proportional" ? base * f : f >= 1 ? base : rule.incorrectPoints;
          break;
        }
        case "incorrect":
          points = rule.incorrectPoints;
          units = 0;
          break;
        case "unanswered":
          points = rule.unansweredPoints;
          units = 0;
          break;
      }
    }
    total += points;
    correctUnits += units;
    if (item.difficulty === "hard" || item.difficulty === "expert") hard += points;
    out.push({ itemId: item.itemId, points: round3(points), maxPoints: round3(base), excluded: false });
  }

  return {
    totalScore: round3(rule.floorAtZero ? Math.max(0, total) : total),
    maxScore: round3(max),
    correctCount: counts.correct,
    incorrectCount: counts.incorrect,
    partialCount: counts.partial,
    unansweredCount: counts.unanswered,
    accuracy: scored === 0 ? 0 : Math.round((correctUnits / scored) * 1e6) / 1e6,
    hardQuestionScore: round3(hard),
    timeMs: time,
    items: out,
  };
}
