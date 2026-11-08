import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING_RULE,
  QualificationError,
  ageOn,
  evaluateEligibility,
  evaluateQualification,
  parseGradeLevel,
  rankByScope,
  rankParticipants,
  remainingAttempts,
  scoreAttempt,
  selectOfficialAttempt,
  type GradedItem,
  type QualificationRule,
  type RankInput,
} from "./index.ts";

describe("grade levels", () => {
  it.each([
    ["K1", -2], ["k3", 0], ["KG", 0], ["P1", 1], ["P.6", 6], ["Grade 5", 5], ["G12", 12], ["Year 3", 3],
    ["S1", 7], ["F6", 12], ["M.3", 9], ["ป.4", 4], ["ม.1", 7], ["อ.2", -1], ["小三", 3], ["中一", 7], ["初三", 9], ["高一", 10],
  ])("%s → %d", (input, level) => expect(parseGradeLevel(input)).toBe(level));

  it.each(["", "P7", "S7", "Grade 13", "Senior", "K4"])("%s is not recognized", (input) => expect(parseGradeLevel(input)).toBeNull());
});

describe("eligibility", () => {
  it("computes age on the cutoff date, including leap-day birthdays", () => {
    expect(ageOn("2015-09-01", "2025-08-31")).toBe(9);
    expect(ageOn("2015-09-01", "2025-09-01")).toBe(10);
    expect(ageOn("2016-02-29", "2025-02-28")).toBe(8);
    expect(ageOn("2016-02-29", "2025-03-01")).toBe(9);
  });

  it("checks age ranges against the admin-defined cutoff", () => {
    const rule = { type: "age" as const, min: 6, max: 9, asOf: "2026-09-01" };
    expect(evaluateEligibility(rule, { dateOfBirth: "2018-09-01" }).eligible).toBe(true);
    expect(evaluateEligibility(rule, { dateOfBirth: "2020-09-02" }).failures[0]!.code).toBe("AGE_TOO_YOUNG");
    expect(evaluateEligibility(rule, { dateOfBirth: "2016-01-01" }).failures[0]!.code).toBe("AGE_TOO_OLD");
  });

  it("reports missing data instead of passing it", () => {
    expect(evaluateEligibility({ type: "age", min: 6, asOf: "2026-09-01" }, {}).failures[0]!.code).toBe("MISSING_DATE_OF_BIRTH");
    expect(evaluateEligibility({ type: "grade_level", min: 1 }, { grade: "Senior" }).failures[0]!.code).toBe("MISSING_GRADE");
  });

  it("combines rules with all/any", () => {
    const rule = {
      type: "any" as const,
      rules: [
        { type: "grade_level" as const, min: 1, max: 6 },
        { type: "all" as const, rules: [{ type: "age" as const, max: 12, asOf: "2026-09-01" }, { type: "grade" as const, in: ["Home-school"] }] },
      ],
    };
    expect(evaluateEligibility(rule, { grade: "P4" }).eligible).toBe(true);
    expect(evaluateEligibility(rule, { grade: "home-school", dateOfBirth: "2016-01-01" }).eligible).toBe(true);
    const fail = evaluateEligibility(rule, { grade: "S2", dateOfBirth: "2012-01-01" });
    expect(fail.eligible).toBe(false);
    expect(fail.failures.map((f) => f.code)).toEqual(["GRADE_TOO_HIGH", "AGE_TOO_OLD", "GRADE_NOT_ALLOWED"]);
  });

  it("checks birth-date windows", () => {
    const rule = { type: "birth_date" as const, from: "2014-09-01", to: "2015-08-31" };
    expect(evaluateEligibility(rule, { dateOfBirth: "2015-08-31" }).eligible).toBe(true);
    expect(evaluateEligibility(rule, { dateOfBirth: "2014-08-31" }).failures[0]!.code).toBe("BORN_TOO_EARLY");
  });
});

describe("scoring", () => {
  const items: GradedItem[] = [
    { itemId: "q1", maxPoints: 2, difficulty: "easy", outcome: "correct", timeMs: 1000 },
    { itemId: "q2", maxPoints: 2, difficulty: "hard", outcome: "incorrect", timeMs: 2000 },
    { itemId: "q3", maxPoints: 3, difficulty: "expert", outcome: "partial", fraction: 1 / 3, timeMs: 3000 },
    { itemId: "q4", maxPoints: 1, difficulty: "medium", outcome: "unanswered" },
  ];

  it("uses item points by default", () => {
    const s = scoreAttempt(items, DEFAULT_SCORING_RULE);
    expect(s).toMatchObject({ totalScore: 2, maxScore: 8, correctCount: 1, incorrectCount: 1, partialCount: 1, unansweredCount: 1, timeMs: 6000, hardQuestionScore: 0 });
    expect(s.accuracy).toBeCloseTo((1 + 1 / 3) / 4, 6);
  });

  it("supports proportional partial credit, negative marking and difficulty weights", () => {
    const s = scoreAttempt(items, {
      ...DEFAULT_SCORING_RULE,
      partialCredit: "proportional",
      incorrectPoints: -0.5,
      difficultyMultipliers: { easy: 1, medium: 1, hard: 2, expert: 2 },
    });
    // q1 2 + q2 -0.5 + q3 (3*2)/3 = 2 → 3.5
    expect(s.totalScore).toBe(3.5);
    expect(s.maxScore).toBe(2 + 4 + 6 + 1);
    expect(s.hardQuestionScore).toBe(1.5);
  });

  it("never goes below zero unless allowed", () => {
    const wrong: GradedItem[] = [{ itemId: "a", maxPoints: 1, difficulty: "easy", outcome: "incorrect" }];
    expect(scoreAttempt(wrong, { ...DEFAULT_SCORING_RULE, incorrectPoints: -1 }).totalScore).toBe(0);
    expect(scoreAttempt(wrong, { ...DEFAULT_SCORING_RULE, incorrectPoints: -1, floorAtZero: false }).totalScore).toBe(-1);
  });

  it("applies emergency adjustments: disabled questions are removed, full credit is awarded", () => {
    const adjusted = items.map((i) => (i.itemId === "q2" ? { ...i, adjustment: "disabled" as const } : i.itemId === "q4" ? { ...i, adjustment: "full_credit" as const } : i));
    const s = scoreAttempt(adjusted, DEFAULT_SCORING_RULE);
    expect(s.maxScore).toBe(6);
    expect(s.totalScore).toBe(3);
    expect(s.items.find((i) => i.itemId === "q2")!.excluded).toBe(true);
  });

  it("is exactly repeatable with fractional points", () => {
    const thirds: GradedItem[] = Array.from({ length: 3 }, (_, i) => ({ itemId: `t${i}`, maxPoints: 1, difficulty: "easy", outcome: "partial", fraction: 1 / 3 }));
    const s = scoreAttempt(thirds, { ...DEFAULT_SCORING_RULE, partialCredit: "proportional" });
    expect(s.totalScore).toBe(1);
  });
});

const p = (id: string, totalScore: number, extra: Partial<RankInput> = {}): RankInput => ({
  participantId: id,
  totalScore,
  accuracy: 0.5,
  timeMs: 60_000,
  hardQuestionScore: 0,
  submittedAt: "2026-10-01T10:00:00Z",
  ...extra,
});

describe("ranking", () => {
  it("orders by tie-breakers in the configured order", () => {
    const people = [
      p("a", 90, { accuracy: 0.9, timeMs: 50_000 }),
      p("b", 90, { accuracy: 0.9, timeMs: 40_000 }),
      p("c", 95),
      p("d", 90, { accuracy: 0.95 }),
    ];
    const { ranked } = rankParticipants(people, ["total_score", "accuracy", "time"]);
    expect(ranked.map((r) => `${r.participantId}:${r.rank}`)).toEqual(["c:1", "d:2", "b:3", "a:4"]);
  });

  it("shares ranks for full ties (1, 2, 2, 4) and lists them deterministically", () => {
    const { ranked } = rankParticipants([p("z", 50), p("y", 80), p("x", 80), p("w", 100)], ["total_score"]);
    expect(ranked.map((r) => [r.participantId, r.rank, r.tiedWith])).toEqual([
      ["w", 1, 1], ["x", 2, 2], ["y", 2, 2], ["z", 4, 1],
    ]);
  });

  it("uses earlier submission as a final tie-breaker", () => {
    const { ranked } = rankParticipants(
      [p("late", 80, { submittedAt: "2026-10-01T10:05:00Z" }), p("early", 80, { submittedAt: "2026-10-01T10:01:00Z" })],
      ["total_score", "earlier_submission"],
    );
    expect(ranked.map((r) => r.participantId)).toEqual(["early", "late"]);
  });

  it("leaves out disqualified and invalidated participants", () => {
    const r = rankParticipants([p("a", 10), p("b", 99, { status: "disqualified" }), p("c", 50, { status: "invalidated" })], ["total_score"]);
    expect(r.ranked.map((x) => x.participantId)).toEqual(["a"]);
    expect(r.unranked).toEqual([{ participantId: "b", status: "disqualified" }, { participantId: "c", status: "invalidated" }]);
  });

  it("ranks within scopes", () => {
    const people = [p("a", 10, { scopes: { school: "s1" } }), p("b", 20, { scopes: { school: "s1" } }), p("c", 5, { scopes: { school: "s2" } }), p("d", 50)];
    const bySchool = rankByScope(people, ["total_score"], "school");
    expect(Object.keys(bySchool)).toEqual(["s1", "s2"]);
    expect(bySchool.s1!.map((x) => [x.participantId, x.rank])).toEqual([["b", 1], ["a", 2]]);
  });
});

describe("qualification", () => {
  const rule = (r: Partial<QualificationRule>): QualificationRule => ({ combine: "any", criteria: [], ties: "include", quota: null, maxWildcards: 0, ...r });
  const field = rankParticipants([p("a", 100), p("b", 90), p("c", 80), p("d", 80), p("e", 70)], ["total_score"]).ranked;
  const qualified = (out: { participantId: string; qualified: boolean }[]) => out.filter((o) => o.qualified).map((o) => o.participantId);

  it("top N includes or excludes ties at the cut-off", () => {
    expect(qualified(evaluateQualification(field, rule({ criteria: [{ type: "top_n", n: 3 }] })))).toEqual(["a", "b", "c", "d"]);
    expect(qualified(evaluateQualification(field, rule({ criteria: [{ type: "top_n", n: 3 }], ties: "exclude" })))).toEqual(["a", "b"]);
  });

  it("top percent rounds down", () => {
    // 5 × 50% = 2.5 → 2
    expect(qualified(evaluateQualification(field, rule({ criteria: [{ type: "top_percent", percent: 50 }] })))).toEqual(["a", "b"]);
  });

  it("combines criteria with any / all", () => {
    const criteria = [{ type: "top_n" as const, n: 1 }, { type: "score_at_least" as const, score: 85 }];
    expect(qualified(evaluateQualification(field, rule({ criteria })))).toEqual(["a", "b"]);
    expect(qualified(evaluateQualification(field, rule({ criteria, combine: "all" })))).toEqual(["a"]);
  });

  it("applies a per-scope quota after the criteria", () => {
    const scoped = rankParticipants(
      [p("a", 100, { scopes: { school: "s1" } }), p("b", 90, { scopes: { school: "s1" } }), p("c", 80, { scopes: { school: "s2" } }), p("d", 70, { scopes: { school: "s1" } })],
      ["total_score"],
    ).ranked;
    const out = evaluateQualification(scoped, rule({ criteria: [{ type: "rank_at_most", rank: 4 }], quota: { scope: "school", max: 2 } }));
    expect(qualified(out)).toEqual(["a", "b", "c"]);
    expect(out.find((o) => o.participantId === "d")!.basis).toBe("quota_exceeded");
  });

  it("manual overrides need reasons and respect the wildcard limit", () => {
    const r = rule({ criteria: [{ type: "top_n", n: 1 }], maxWildcards: 1 });
    const out = evaluateQualification(field, r, [
      { participantId: "e", action: "include", reason: "Medical make-up approved" },
      { participantId: "a", action: "exclude", reason: "Withdrew" },
    ]);
    expect(qualified(out)).toEqual(["e"]);
    expect(out.find((o) => o.participantId === "e")).toMatchObject({ basis: "manual_include", reason: "Medical make-up approved" });
    expect(() => evaluateQualification(field, r, [{ participantId: "e", action: "include", reason: " " }])).toThrow(QualificationError);
    expect(() =>
      evaluateQualification(field, r, [
        { participantId: "d", action: "include", reason: "x" },
        { participantId: "e", action: "include", reason: "y" },
      ]),
    ).toThrow(/exceed/);
  });

  it("is deterministic regardless of input order", () => {
    const shuffled = rankParticipants([p("e", 70), p("c", 80), p("a", 100), p("d", 80), p("b", 90)], ["total_score"]).ranked;
    const r = rule({ criteria: [{ type: "top_n", n: 3 }] });
    expect(evaluateQualification(shuffled, r)).toEqual(evaluateQualification(field, r));
  });
});

describe("attempt policy", () => {
  const attempt = (id: string, totalScore: number, submittedAt: string, status: "submitted" | "invalidated" = "submitted") => ({
    attemptId: id, totalScore, accuracy: 0.5, timeMs: 1000, hardQuestionScore: 0, submittedAt, status,
  });
  const attempts = [
    attempt("a1", 60, "2026-10-01T10:00:00Z"),
    attempt("a2", 80, "2026-10-02T10:00:00Z"),
    attempt("a3", 70, "2026-10-03T10:00:00Z"),
    attempt("a4", 99, "2026-10-04T10:00:00Z", "invalidated"),
  ];

  it("selects best / latest / first among valid attempts", () => {
    const tb = ["total_score" as const];
    expect(selectOfficialAttempt(attempts, { maxAttempts: 3, counting: "best" }, tb)!.attemptId).toBe("a2");
    expect(selectOfficialAttempt(attempts, { maxAttempts: 3, counting: "latest" }, tb)!.attemptId).toBe("a3");
    expect(selectOfficialAttempt(attempts, { maxAttempts: 3, counting: "first" }, tb)!.attemptId).toBe("a1");
    expect(selectOfficialAttempt([attempts[3]!], { maxAttempts: 3, counting: "best" }, tb)).toBeNull();
  });

  it("counts remaining attempts, with make-up grants", () => {
    expect(remainingAttempts({ maxAttempts: 1, counting: "best" }, 1)).toBe(0);
    expect(remainingAttempts({ maxAttempts: 1, counting: "best" }, 1, 1)).toBe(1);
    expect(remainingAttempts({ maxAttempts: null, counting: "best" }, 50)).toBeNull();
  });
});
