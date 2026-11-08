import { describe, expect, it } from "vitest";
import { MIN_COHORT, compareToCohort, masteryBySkill, strengthsAndWeaknesses } from "./index.ts";

const now = new Date("2026-12-01T00:00:00Z");
const obs = (skillId: string, at: string, correct: number, total: number, source: "official" | "practice" = "official") => ({ skillId, observedAt: at, correct, total, source });

describe("skill mastery", () => {
  it("weights recent and official evidence more, and tracks the trend", () => {
    const m = masteryBySkill([
      obs("tones", "2026-03-01T00:00:00Z", 2, 10),
      obs("tones", "2026-11-25T00:00:00Z", 9, 10),
      obs("tones", "2026-11-28T00:00:00Z", 6, 10, "practice"),
      obs("finals", "2026-11-20T00:00:00Z", 3, 10),
    ], now);
    const tones = m.find((x) => x.skillId === "tones")!;
    expect(tones.mastery).toBeGreaterThan(0.7);
    expect(tones.trend.map((t) => t.score)).toEqual([0.2, 0.9, 0.6]);
    expect(tones.lastChange).toBe(-0.3);
    expect(tones.questions).toBe(30);
    const { strengths, weaknesses } = strengthsAndWeaknesses(m);
    expect(strengths.map((s) => s.skillId)).toEqual(["tones"]);
    expect(weaknesses.map((s) => s.skillId)).toEqual(["finals"]);
  });

  it("needs enough evidence before calling something a weakness", () => {
    const m = masteryBySkill([obs("rare", "2026-11-20T00:00:00Z", 0, 2)], now);
    expect(strengthsAndWeaknesses(m).weaknesses).toEqual([]);
  });
});

describe("cohort comparisons", () => {
  it("are only shown for cohorts large enough to stay anonymous", () => {
    expect(compareToCohort(0.8, [0.5, 0.9])).toEqual({ available: false, cohortSize: 2, average: null, percentile: null });
    const cohort = Array.from({ length: MIN_COHORT }, (_, i) => i / 10);
    expect(compareToCohort(0.75, cohort)).toEqual({ available: true, cohortSize: 10, average: 0.45, percentile: 80 });
  });
});
