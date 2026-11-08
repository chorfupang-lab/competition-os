import { round3 } from "./scoring.ts";
import { rankParticipants, type RankedEntry, type RankingScope, type TieBreaker } from "./ranking.ts";

/**
 * Qualification: deterministic, rule-based, with an explicit manual layer.
 * AI never takes part (hard rule 18). Steps:
 *   1. criteria (top N, top %, score threshold, rank) combined with any/all
 *   2. optional quota per scope (e.g. at most 3 per school)
 *   3. manual overrides: wildcard includes (limited) and excludes, each with a reason
 *
 * Ties at a cut-off follow `ties`: "include" lets everyone sharing the boundary
 * rank through; "exclude" lets none of them through.
 */
export type QualificationCriterion =
  | { type: "top_n"; n: number }
  | { type: "top_percent"; percent: number }
  | { type: "score_at_least"; score: number }
  | { type: "rank_at_most"; rank: number };

export interface QualificationRule {
  combine: "any" | "all";
  criteria: QualificationCriterion[];
  ties: "include" | "exclude";
  quota: { scope: Exclude<RankingScope, "group">; max: number } | null;
  maxWildcards: number;
}

export interface QualificationOverride {
  participantId: string;
  action: "include" | "exclude";
  reason: string;
}

export type QualificationBasis = "rule" | "manual_include" | "manual_exclude" | "quota_exceeded" | "not_met";

export interface QualificationOutcome {
  participantId: string;
  rank: number;
  qualified: boolean;
  basis: QualificationBasis;
  matchedCriteria: QualificationCriterion["type"][];
  reason?: string;
}

export class QualificationError extends Error {}

function fitsWithin(entry: { rank: number; tiedWith: number }, slots: number, ties: "include" | "exclude"): boolean {
  if (entry.rank > slots) return false;
  return ties === "include" || entry.rank + entry.tiedWith - 1 <= slots;
}

export function evaluateQualification(
  ranked: readonly RankedEntry[],
  rule: QualificationRule,
  overrides: readonly QualificationOverride[] = [],
  tieBreakers: readonly TieBreaker[] = ["total_score"],
): QualificationOutcome[] {
  const total = ranked.length;
  const percentSlots = (p: number) => Math.floor(round3((total * p) / 100));

  const outcomes = new Map<string, QualificationOutcome>();
  for (const e of ranked) {
    const matched: QualificationCriterion["type"][] = [];
    for (const c of rule.criteria) {
      const ok =
        c.type === "top_n" ? fitsWithin(e, c.n, rule.ties)
        : c.type === "top_percent" ? fitsWithin(e, percentSlots(c.percent), rule.ties)
        : c.type === "score_at_least" ? e.totalScore >= c.score
        : e.rank <= c.rank;
      if (ok) matched.push(c.type);
    }
    const met = rule.combine === "any" ? matched.length > 0 : matched.length === rule.criteria.length && rule.criteria.length > 0;
    outcomes.set(e.participantId, { participantId: e.participantId, rank: e.rank, qualified: met, basis: met ? "rule" : "not_met", matchedCriteria: matched });
  }

  if (rule.quota) {
    const scope = rule.quota.scope;
    const byScope = new Map<string, RankedEntry[]>();
    for (const e of ranked) {
      if (!outcomes.get(e.participantId)!.qualified) continue;
      const key = e.scopes?.[scope] ?? "";
      byScope.set(key, [...(byScope.get(key) ?? []), e]);
    }
    for (const entries of byScope.values()) {
      for (const e of rankParticipants(entries, tieBreakers).ranked) {
        if (!fitsWithin(e, rule.quota.max, rule.ties)) {
          const o = outcomes.get(e.participantId)!;
          o.qualified = false;
          o.basis = "quota_exceeded";
        }
      }
    }
  }

  const seen = new Set<string>();
  let wildcards = 0;
  for (const ov of overrides) {
    if (seen.has(ov.participantId)) throw new QualificationError(`more than one override for ${ov.participantId}`);
    seen.add(ov.participantId);
    if (!ov.reason?.trim()) throw new QualificationError("every override needs a reason");
    const o = outcomes.get(ov.participantId);
    if (!o) throw new QualificationError(`${ov.participantId} is not a ranked participant`);
    if (ov.action === "include") {
      if (!o.qualified) wildcards++;
      o.qualified = true;
      o.basis = "manual_include";
    } else {
      o.qualified = false;
      o.basis = "manual_exclude";
    }
    o.reason = ov.reason.trim();
  }
  if (wildcards > rule.maxWildcards) throw new QualificationError(`${wildcards} wildcards exceed the limit of ${rule.maxWildcards}`);

  return ranked.map((e) => outcomes.get(e.participantId)!);
}
