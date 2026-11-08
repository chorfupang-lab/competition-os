/**
 * Learning Passport analytics. Deterministic, explainable aggregation of
 * per-skill observations from attempts (official and practice).
 */
export interface SkillObservation {
  skillId: string;
  observedAt: string;
  /** Correct units (partials count fractionally) and total questions for this skill in one attempt. */
  correct: number;
  total: number;
  source: "official" | "practice";
}

export interface SkillMastery {
  skillId: string;
  /** 0..1, recency-weighted. */
  mastery: number;
  questions: number;
  attempts: number;
  trend: Array<{ at: string; score: number }>;
  /** Change between the two most recent observations (null with fewer than two). */
  lastChange: number | null;
}

/**
 * Recency-weighted mastery: each observation's weight halves every
 * `halfLifeDays`; official observations count double compared with practice.
 */
export function masteryBySkill(observations: readonly SkillObservation[], now = new Date(), halfLifeDays = 90): SkillMastery[] {
  const bySkill = new Map<string, SkillObservation[]>();
  for (const o of observations) {
    if (o.total <= 0) continue;
    bySkill.set(o.skillId, [...(bySkill.get(o.skillId) ?? []), o]);
  }
  const out: SkillMastery[] = [];
  for (const [skillId, list] of bySkill) {
    const sorted = [...list].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    let wSum = 0;
    let vSum = 0;
    for (const o of sorted) {
      const ageDays = Math.max(0, (now.getTime() - Date.parse(o.observedAt)) / 86_400_000);
      const w = Math.pow(0.5, ageDays / halfLifeDays) * (o.source === "official" ? 2 : 1) * o.total;
      wSum += w;
      vSum += w * (o.correct / o.total);
    }
    const trend = sorted.map((o) => ({ at: o.observedAt, score: Math.round((o.correct / o.total) * 1000) / 1000 }));
    out.push({
      skillId,
      mastery: wSum ? Math.round((vSum / wSum) * 1000) / 1000 : 0,
      questions: sorted.reduce((s, o) => s + o.total, 0),
      attempts: sorted.length,
      trend,
      lastChange: trend.length >= 2 ? Math.round((trend[trend.length - 1]!.score - trend[trend.length - 2]!.score) * 1000) / 1000 : null,
    });
  }
  return out.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

/** Weak areas: lowest mastery with enough evidence; strengths: highest. */
export function strengthsAndWeaknesses(m: readonly SkillMastery[], minQuestions = 3, n = 3) {
  const eligible = m.filter((x) => x.questions >= minQuestions);
  const byMastery = [...eligible].sort((a, b) => a.mastery - b.mastery || a.skillId.localeCompare(b.skillId));
  const weaknesses = byMastery.filter((x) => x.mastery < 0.7).slice(0, n);
  const strengths = [...byMastery].reverse().filter((x) => x.mastery >= 0.7).slice(0, n);
  return { strengths, weaknesses };
}

/**
 * Comparisons are aggregates over a cohort and are only shown when the
 * cohort is large enough that no individual can be singled out.
 */
export const MIN_COHORT = 10;

export interface CohortComparison {
  available: boolean;
  cohortSize: number;
  average: number | null;
  /** Share of the cohort scoring at or below the student (0–100). */
  percentile: number | null;
}

export function compareToCohort(value: number, cohort: readonly number[], minCohort = MIN_COHORT): CohortComparison {
  if (cohort.length < minCohort) return { available: false, cohortSize: cohort.length, average: null, percentile: null };
  const avg = cohort.reduce((s, v) => s + v, 0) / cohort.length;
  const atOrBelow = cohort.filter((v) => v <= value).length;
  return { available: true, cohortSize: cohort.length, average: Math.round(avg * 1000) / 1000, percentile: Math.round((atOrBelow / cohort.length) * 100) };
}
