import { z } from "zod";
import { PRONUNCIATION_ASPECTS } from "../content/items.ts";

/**
 * Pronunciation assessment as returned by any provider adapter, normalized
 * to 0–100 per aspect. Providers that cannot measure an aspect omit it.
 */
export const PronunciationAssessmentSchema = z.object({
  overall: z.number().min(0).max(100),
  aspects: z.partialRecord(z.enum(PRONUNCIATION_ASPECTS), z.number().min(0).max(100)),
  /** Per-syllable / per-word detail (e.g. tone heard vs expected). */
  units: z
    .array(z.object({ text: z.string().max(50), score: z.number().min(0).max(100), expected: z.string().max(50).optional(), heard: z.string().max(50).optional() }))
    .max(500)
    .default([]),
  durationMs: z.number().int().min(0).max(600_000).optional(),
});
export type PronunciationAssessment = z.infer<typeof PronunciationAssessmentSchema>;

/**
 * Deterministic rubric: AI measurements → SUGGESTED grade. The suggestion is
 * shown to a judge, who confirms it for official attempts (AI never sets an
 * official score). Practice attempts use it directly.
 *
 * Only the item's configured aspects count; missing aspects fall back to overall.
 */
export function suggestedFraction(a: PronunciationAssessment, aspects: readonly string[], thresholds = { full: 85, zero: 40 }): number {
  const values = aspects.map((k) => a.aspects[k as keyof typeof a.aspects] ?? a.overall);
  const mean = values.length ? values.reduce((s, v) => s + v, 0) / values.length : a.overall;
  if (mean >= thresholds.full) return 1;
  if (mean <= thresholds.zero) return 0;
  return Math.round(((mean - thresholds.zero) / (thresholds.full - thresholds.zero)) * 100) / 100;
}
