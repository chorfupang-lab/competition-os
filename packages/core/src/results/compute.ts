import { selectOfficialAttempt, type AttemptPolicy, type AttemptRecord } from "../competition/attempts.ts";
import { evaluateQualification, type QualificationOverride, type QualificationRule } from "../competition/qualification.ts";
import { rankByScope, rankParticipants, type RankInput, type RankingScope, type TieBreaker } from "../competition/ranking.ts";

/**
 * Official results for one round × group: deterministic from the attempts,
 * the round's rules, integrity decisions and Head Judge overrides. The same
 * inputs always produce the same entries (hard rule 17).
 */
export interface ParticipantInput {
  registrationId: string;
  studentId: string;
  attempts: AttemptRecord[];
  /** A Head Judge disqualification from an integrity case. */
  disqualified: boolean;
  scopes: Partial<Record<Exclude<RankingScope, "group">, string>>;
}

export type ResultOverride =
  | { registrationId: string; type: "score"; totalScore: number; reason: string }
  | { registrationId: string; type: "qualification"; action: "include" | "exclude"; reason: string };

export interface ResultEntry {
  registrationId: string;
  studentId: string;
  attemptId: string | null;
  status: "ok" | "disqualified" | "no_attempt";
  totalScore: number | null;
  /** Score before a Head Judge score override, when one applies. */
  originalScore: number | null;
  accuracy: number | null;
  timeMs: number | null;
  hardQuestionScore: number | null;
  submittedAt: string | null;
  rank: number | null;
  tiedWith: number | null;
  scopeRanks: Partial<Record<RankingScope, number>>;
  qualified: boolean;
  qualificationBasis: string | null;
  overrides: ResultOverride[];
}

export interface ComputeInput {
  participants: ParticipantInput[];
  policy: AttemptPolicy;
  tieBreakers: TieBreaker[];
  scopes: RankingScope[];
  qualification: QualificationRule | null;
  overrides: ResultOverride[];
}

export class ResultsError extends Error {}

export function computeResults(input: ComputeInput): ResultEntry[] {
  const overridesBy = new Map<string, ResultOverride[]>();
  for (const o of input.overrides) {
    if (!o.reason?.trim()) throw new ResultsError("every override needs a reason");
    overridesBy.set(o.registrationId, [...(overridesBy.get(o.registrationId) ?? []), o]);
  }
  const known = new Set(input.participants.map((p) => p.registrationId));
  for (const id of overridesBy.keys()) if (!known.has(id)) throw new ResultsError(`override for unknown registration ${id}`);

  const official = input.participants.map((p) => ({ p, attempt: selectOfficialAttempt(p.attempts, input.policy, input.tieBreakers) }));
  const rankInputs: RankInput[] = [];
  const scoreOverride = new Map<string, number>();
  for (const { p, attempt } of official) {
    if (!attempt) continue;
    const so = overridesBy.get(p.registrationId)?.find((o) => o.type === "score");
    if (so && so.type === "score") scoreOverride.set(p.registrationId, so.totalScore);
    rankInputs.push({
      participantId: p.registrationId,
      totalScore: so && so.type === "score" ? so.totalScore : attempt.totalScore,
      accuracy: attempt.accuracy,
      timeMs: attempt.timeMs,
      hardQuestionScore: attempt.hardQuestionScore,
      submittedAt: attempt.submittedAt,
      status: p.disqualified ? "disqualified" : "ok",
      scopes: p.scopes,
    });
  }
  const ranking = rankParticipants(rankInputs, input.tieBreakers);
  const byId = new Map(ranking.ranked.map((r) => [r.participantId, r]));
  const scoped = new Map<string, Partial<Record<RankingScope, number>>>();
  for (const scope of input.scopes) {
    if (scope === "group") continue;
    for (const entries of Object.values(rankByScope(rankInputs.filter((r) => r.status !== "disqualified"), input.tieBreakers, scope))) {
      for (const e of entries) scoped.set(e.participantId, { ...(scoped.get(e.participantId) ?? {}), [scope]: e.rank });
    }
  }
  const qOverrides: QualificationOverride[] = input.overrides
    .filter((o): o is Extract<ResultOverride, { type: "qualification" }> => o.type === "qualification")
    .filter((o) => byId.has(o.registrationId))
    .map((o) => ({ participantId: o.registrationId, action: o.action, reason: o.reason }));
  const qualification = input.qualification
    ? new Map(evaluateQualification(ranking.ranked, input.qualification, qOverrides, input.tieBreakers).map((q) => [q.participantId, q]))
    : new Map();

  return official
    .map(({ p, attempt }): ResultEntry => {
      const r = byId.get(p.registrationId);
      const q = qualification.get(p.registrationId);
      const status = !attempt ? "no_attempt" : p.disqualified ? "disqualified" : "ok";
      return {
        registrationId: p.registrationId,
        studentId: p.studentId,
        attemptId: attempt?.attemptId ?? null,
        status,
        totalScore: attempt ? (scoreOverride.get(p.registrationId) ?? attempt.totalScore) : null,
        originalScore: scoreOverride.has(p.registrationId) && attempt ? attempt.totalScore : null,
        accuracy: attempt?.accuracy ?? null,
        timeMs: attempt?.timeMs ?? null,
        hardQuestionScore: attempt?.hardQuestionScore ?? null,
        submittedAt: attempt?.submittedAt ?? null,
        rank: r?.rank ?? null,
        tiedWith: r?.tiedWith ?? null,
        scopeRanks: { ...(r ? { group: r.rank } : {}), ...(scoped.get(p.registrationId) ?? {}) },
        qualified: q?.qualified ?? false,
        qualificationBasis: q?.basis ?? (status === "disqualified" ? "disqualified" : status === "no_attempt" ? "no_attempt" : null),
        overrides: overridesBy.get(p.registrationId) ?? [],
      };
    })
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.registrationId.localeCompare(b.registrationId));
}

export interface ResultChange {
  registrationId: string;
  before: Pick<ResultEntry, "totalScore" | "rank" | "qualified" | "status"> | null;
  after: Pick<ResultEntry, "totalScore" | "rank" | "qualified" | "status"> | null;
}

/** Before/after for every participant whose score, rank, qualification or status changed. */
export function diffResults(before: readonly ResultEntry[], after: readonly ResultEntry[]): ResultChange[] {
  const pick = (e: ResultEntry | undefined) => (e ? { totalScore: e.totalScore, rank: e.rank, qualified: e.qualified, status: e.status } : null);
  const b = new Map(before.map((e) => [e.registrationId, e]));
  const a = new Map(after.map((e) => [e.registrationId, e]));
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort();
  return ids
    .map((id) => ({ registrationId: id, before: pick(b.get(id)), after: pick(a.get(id)) }))
    .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
}
