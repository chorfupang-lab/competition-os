import type { CompetitionConfig } from "./config.ts";
import { evaluateEligibility, type EligibilityResult, type EligibilitySubject } from "./eligibility.ts";

/** Eligibility for every group, e.g. for the parent flow "Select child → Competition → Group eligibility". */
export function eligibleGroups(config: CompetitionConfig, subject: EligibilitySubject): Array<{ groupId: string; key: string; name: CompetitionConfig["groups"][number]["name"] } & EligibilityResult> {
  return config.groups.map((g) => ({ groupId: g.id, key: g.key, name: g.name, ...evaluateEligibility(g.eligibility, subject) }));
}

/**
 * What participants and the public may see of a published configuration:
 * groups, eligibility, rounds, timing and formats. Internal settings
 * (content bank versions, scoring weights, integrity tuning, qualification
 * parameters) stay inside the tenant.
 */
export function publicConfigView(config: CompetitionConfig) {
  return {
    groups: config.groups.map((g) => ({ id: g.id, key: g.key, name: g.name, eligibility: g.eligibility, capacity: g.capacity })),
    rounds: config.rounds.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      kind: r.kind,
      opensAt: r.opensAt,
      closesAt: r.closesAt,
      entry: r.entry,
      attemptPolicy: r.attemptPolicy,
      groups: r.groups
        .filter((g) => g.enabled)
        .map((g) => ({ groupId: g.groupId, durationSeconds: g.durationSeconds, questionCount: g.questionCount, questionFormats: g.questionFormats })),
    })),
  };
}
