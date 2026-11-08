import { describe, expect, it } from "vitest";
import { anonymousCode, computeResults, diffResults, displayName, ResultsError, type ComputeInput, type ParticipantInput } from "./index.ts";

const attempt = (id: string, totalScore: number, status: "submitted" | "invalidated" = "submitted", at = "2026-12-01T10:00:00Z") => ({
  attemptId: id, totalScore, accuracy: totalScore / 100, timeMs: 60_000, hardQuestionScore: 0, submittedAt: at, status,
});
const p = (id: string, attempts: ParticipantInput["attempts"], extra: Partial<ParticipantInput> = {}): ParticipantInput => ({
  registrationId: id, studentId: `s-${id}`, attempts, disqualified: false, scopes: { school: id < "c" ? "s1" : "s2" }, ...extra,
});
const base = (participants: ParticipantInput[], extra: Partial<ComputeInput> = {}): ComputeInput => ({
  participants,
  policy: { maxAttempts: 2, counting: "best" },
  tieBreakers: ["total_score", "accuracy", "earlier_submission"],
  scopes: ["group", "school"],
  qualification: { combine: "any", criteria: [{ type: "top_n", n: 2 }], ties: "include", quota: null, maxWildcards: 1 },
  overrides: [],
  ...extra,
});

describe("computeResults", () => {
  it("uses the official attempt per policy, ranks, scope-ranks and qualifies", () => {
    const out = computeResults(base([
      p("a", [attempt("a1", 70), attempt("a2", 90)]),
      p("b", [attempt("b1", 95, "invalidated"), attempt("b2", 80)]),
      p("c", [attempt("c1", 85)]),
      p("d", []),
    ]));
    expect(out.map((e) => [e.registrationId, e.attemptId, e.totalScore, e.rank, e.qualified, e.status])).toEqual([
      ["a", "a2", 90, 1, true, "ok"],
      ["c", "c1", 85, 2, true, "ok"],
      ["b", "b2", 80, 3, false, "ok"],
      ["d", null, null, null, false, "no_attempt"],
    ]);
    expect(out[0]!.scopeRanks).toEqual({ group: 1, school: 1 });
    expect(out[2]!.scopeRanks).toEqual({ group: 3, school: 2 });
  });

  it("disqualified participants are unranked and never qualify", () => {
    const out = computeResults(base([p("a", [attempt("a1", 99)], { disqualified: true }), p("b", [attempt("b1", 50)])]));
    expect(out.find((e) => e.registrationId === "a")).toMatchObject({ status: "disqualified", rank: null, qualified: false, qualificationBasis: "disqualified" });
    expect(out.find((e) => e.registrationId === "b")).toMatchObject({ rank: 1, qualified: true });
  });

  it("applies Head Judge overrides: score corrections re-rank, qualification wildcards and exclusions", () => {
    const participants = [p("a", [attempt("a1", 90)]), p("b", [attempt("b1", 80)]), p("c", [attempt("c1", 70)])];
    const out = computeResults(base(participants, {
      overrides: [
        { registrationId: "c", type: "score", totalScore: 95, reason: "Question 4 answer key corrected" },
        { registrationId: "b", type: "qualification", action: "include", reason: "Wildcard: medical make-up" },
      ],
    }));
    expect(out.map((e) => [e.registrationId, e.totalScore, e.originalScore, e.rank, e.qualified, e.qualificationBasis])).toEqual([
      ["c", 95, 70, 1, true, "rule"],
      ["a", 90, null, 2, true, "rule"],
      ["b", 80, null, 3, true, "manual_include"],
    ]);
    expect(() => computeResults(base(participants, { overrides: [{ registrationId: "a", type: "score", totalScore: 1, reason: "" }] }))).toThrow(ResultsError);
    expect(() => computeResults(base(participants, { overrides: [{ registrationId: "zzz", type: "score", totalScore: 1, reason: "x" }] }))).toThrow(/unknown/);
  });

  it("is deterministic and diffs cleanly", () => {
    const participants = [p("a", [attempt("a1", 90)]), p("b", [attempt("b1", 80)]), p("c", [attempt("c1", 70)])];
    const before = computeResults(base(participants));
    expect(computeResults(base([...participants].reverse()))).toEqual(before);
    const after = computeResults(base(participants, { overrides: [{ registrationId: "c", type: "score", totalScore: 85, reason: "Recount" }] }));
    expect(diffResults(before, after)).toEqual([
      { registrationId: "b", before: { totalScore: 80, rank: 2, qualified: true, status: "ok" }, after: { totalScore: 80, rank: 3, qualified: false, status: "ok" } },
      { registrationId: "c", before: { totalScore: 70, rank: 3, qualified: false, status: "ok" }, after: { totalScore: 85, rank: 2, qualified: true, status: "ok" } },
    ]);
  });
});

describe("leaderboard privacy", () => {
  const s = { competitionId: "comp-1", studentId: "stu-1", givenName: "Mei", familyName: "Chan", preferredName: null, nickname: null };
  it("renders each mode, falling back to an anonymous code", () => {
    expect(displayName("full_name", s)).toBe("Mei Chan");
    expect(displayName("first_name_initial", s)).toBe("Mei C.");
    expect(displayName("nickname", { ...s, nickname: "Panda" })).toBe("Panda");
    expect(displayName("nickname", s)).toMatch(/^P-[2-9A-Z]{6}$/);
    expect(displayName("rank_score_only", s)).toBeNull();
  });
  it("anonymous codes are stable per competition and differ across competitions", () => {
    expect(anonymousCode("comp-1", "stu-1")).toBe(anonymousCode("comp-1", "stu-1"));
    expect(anonymousCode("comp-2", "stu-1")).not.toBe(anonymousCode("comp-1", "stu-1"));
  });
});
