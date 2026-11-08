/**
 * Ranking. Deterministic: participants are ordered by the configured
 * tie-breakers; anyone still equal after every tie-breaker shares the rank
 * ("1, 2, 2, 4"). Output order within a shared rank is by participantId so
 * repeated runs list them identically.
 */
export const TIE_BREAKERS = ["total_score", "accuracy", "time", "hard_question_score", "earlier_submission"] as const;
export type TieBreaker = (typeof TIE_BREAKERS)[number];

export const RANKING_SCOPES = ["group", "school", "country", "region", "class", "team"] as const;
export type RankingScope = (typeof RANKING_SCOPES)[number];

export interface RankInput {
  participantId: string;
  totalScore: number;
  accuracy: number;
  timeMs: number;
  hardQuestionScore: number;
  /** ISO timestamp of the official attempt's submission. */
  submittedAt: string;
  /** Disqualified and invalidated participants are not ranked. */
  status?: "ok" | "disqualified" | "invalidated";
  /** Scope values for scoped rankings, e.g. { school: "<school id>", country: "HK" }. */
  scopes?: Partial<Record<Exclude<RankingScope, "group">, string>>;
}

export interface RankedEntry extends RankInput {
  rank: number;
  /** How many participants share this rank (1 = no tie). */
  tiedWith: number;
}

export interface RankingResult {
  ranked: RankedEntry[];
  unranked: Array<{ participantId: string; status: "disqualified" | "invalidated" }>;
}

export function compareParticipants(a: RankInput, b: RankInput, tieBreakers: readonly TieBreaker[]): number {
  for (const tb of tieBreakers) {
    let d = 0;
    switch (tb) {
      case "total_score":
        d = b.totalScore - a.totalScore;
        break;
      case "accuracy":
        d = b.accuracy - a.accuracy;
        break;
      case "time":
        d = a.timeMs - b.timeMs;
        break;
      case "hard_question_score":
        d = b.hardQuestionScore - a.hardQuestionScore;
        break;
      case "earlier_submission":
        d = Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
        break;
    }
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function rankParticipants(participants: readonly RankInput[], tieBreakers: readonly TieBreaker[]): RankingResult {
  const unranked: RankingResult["unranked"] = [];
  const eligible: RankInput[] = [];
  for (const p of participants) {
    if (p.status === "disqualified" || p.status === "invalidated") unranked.push({ participantId: p.participantId, status: p.status });
    else eligible.push(p);
  }
  const sorted = [...eligible].sort(
    (a, b) => compareParticipants(a, b, tieBreakers) || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0),
  );
  const ranked: RankedEntry[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && compareParticipants(sorted[i]!, sorted[j]!, tieBreakers) === 0) j++;
    for (let k = i; k < j; k++) ranked.push({ ...sorted[k]!, rank: i + 1, tiedWith: j - i });
    i = j;
  }
  unranked.sort((a, b) => (a.participantId < b.participantId ? -1 : 1));
  return { ranked, unranked };
}

/** Rankings within each value of a scope (e.g. per school). Participants without a value are left out. */
export function rankByScope(
  participants: readonly RankInput[],
  tieBreakers: readonly TieBreaker[],
  scope: RankingScope,
): Record<string, RankedEntry[]> {
  if (scope === "group") return { all: rankParticipants(participants, tieBreakers).ranked };
  const buckets = new Map<string, RankInput[]>();
  for (const p of participants) {
    const v = p.scopes?.[scope];
    if (!v) continue;
    const list = buckets.get(v) ?? [];
    list.push(p);
    buckets.set(v, list);
  }
  const out: Record<string, RankedEntry[]> = {};
  for (const key of [...buckets.keys()].sort()) out[key] = rankParticipants(buckets.get(key)!, tieBreakers).ranked;
  return out;
}
