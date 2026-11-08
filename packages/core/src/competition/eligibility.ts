import { parseGradeLevel } from "./grades.ts";

/**
 * Eligibility rules, configured per group by the Competition Admin.
 * Rules compose with all/any. Missing student data never passes silently: it
 * fails with a MISSING_* reason so the registrant can supply it.
 */
export type EligibilityRule =
  | { type: "open" }
  | { type: "all"; rules: EligibilityRule[] }
  | { type: "any"; rules: EligibilityRule[] }
  /** Age in whole years on the admin-defined cutoff date. */
  | { type: "age"; min?: number | undefined; max?: number | undefined; asOf: string }
  | { type: "birth_date"; from?: string | undefined; to?: string | undefined }
  | { type: "grade_level"; min?: number | undefined; max?: number | undefined }
  /** Exact grade codes as the organizer writes them, case-insensitive. */
  | { type: "grade"; in: string[] };

export interface EligibilitySubject {
  /** YYYY-MM-DD */
  dateOfBirth?: string | null | undefined;
  grade?: string | null | undefined;
  gradeLevel?: number | null | undefined;
}

export type EligibilityFailureCode =
  | "MISSING_DATE_OF_BIRTH"
  | "MISSING_GRADE"
  | "AGE_TOO_YOUNG"
  | "AGE_TOO_OLD"
  | "BORN_TOO_EARLY"
  | "BORN_TOO_LATE"
  | "GRADE_TOO_LOW"
  | "GRADE_TOO_HIGH"
  | "GRADE_NOT_ALLOWED";

export interface EligibilityFailure {
  code: EligibilityFailureCode;
  rule: EligibilityRule["type"];
  detail?: Record<string, unknown>;
}

export interface EligibilityResult {
  eligible: boolean;
  failures: EligibilityFailure[];
}

/** Whole years between dateOfBirth and asOf (both YYYY-MM-DD). */
export function ageOn(dateOfBirth: string, asOf: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [ay, am, ad] = asOf.split("-").map(Number) as [number, number, number];
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age;
}

export function evaluateEligibility(rule: EligibilityRule, subject: EligibilitySubject): EligibilityResult {
  const failures = evaluate(rule, subject);
  return { eligible: failures.length === 0, failures };
}

function evaluate(rule: EligibilityRule, s: EligibilitySubject): EligibilityFailure[] {
  switch (rule.type) {
    case "open":
      return [];
    case "all":
      return rule.rules.flatMap((r) => evaluate(r, s));
    case "any": {
      const results = rule.rules.map((r) => evaluate(r, s));
      return results.some((f) => f.length === 0) ? [] : results.flat();
    }
    case "age": {
      if (!s.dateOfBirth) return [{ code: "MISSING_DATE_OF_BIRTH", rule: rule.type }];
      const age = ageOn(s.dateOfBirth, rule.asOf);
      if (rule.min !== undefined && age < rule.min) return [{ code: "AGE_TOO_YOUNG", rule: rule.type, detail: { age, min: rule.min, asOf: rule.asOf } }];
      if (rule.max !== undefined && age > rule.max) return [{ code: "AGE_TOO_OLD", rule: rule.type, detail: { age, max: rule.max, asOf: rule.asOf } }];
      return [];
    }
    case "birth_date": {
      if (!s.dateOfBirth) return [{ code: "MISSING_DATE_OF_BIRTH", rule: rule.type }];
      if (rule.from && s.dateOfBirth < rule.from) return [{ code: "BORN_TOO_EARLY", rule: rule.type, detail: { from: rule.from } }];
      if (rule.to && s.dateOfBirth > rule.to) return [{ code: "BORN_TOO_LATE", rule: rule.type, detail: { to: rule.to } }];
      return [];
    }
    case "grade_level": {
      const level = s.gradeLevel ?? parseGradeLevel(s.grade);
      if (level === null || level === undefined) return [{ code: "MISSING_GRADE", rule: rule.type }];
      if (rule.min !== undefined && level < rule.min) return [{ code: "GRADE_TOO_LOW", rule: rule.type, detail: { gradeLevel: level, min: rule.min } }];
      if (rule.max !== undefined && level > rule.max) return [{ code: "GRADE_TOO_HIGH", rule: rule.type, detail: { gradeLevel: level, max: rule.max } }];
      return [];
    }
    case "grade": {
      if (!s.grade?.trim()) return [{ code: "MISSING_GRADE", rule: rule.type }];
      const g = s.grade.trim().toLowerCase();
      if (!rule.in.some((x) => x.trim().toLowerCase() === g)) return [{ code: "GRADE_NOT_ALLOWED", rule: rule.type, detail: { grade: s.grade, allowed: rule.in } }];
      return [];
    }
  }
}

export function eligibilityDepth(rule: EligibilityRule): number {
  return rule.type === "all" || rule.type === "any" ? 1 + Math.max(0, ...rule.rules.map(eligibilityDepth)) : 1;
}
