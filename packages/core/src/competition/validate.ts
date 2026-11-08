import type { CompetitionConfig } from "./config.ts";
import { eligibilityDepth, type EligibilityRule } from "./eligibility.ts";

/**
 * Semantic checks beyond the schema. Errors block publishing; warnings are
 * shown to the admin but do not block.
 */
export interface ConfigIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface ValidateOptions {
  now?: Date;
  /** The currently published config, when validating a new version of a published competition. */
  published?: CompetitionConfig | null;
}

export function validateConfig(config: CompetitionConfig, options: ValidateOptions = {}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (code: string, path: string, message: string) => issues.push({ severity: "error", code, path, message });
  const warn = (code: string, path: string, message: string) => issues.push({ severity: "warning", code, path, message });
  const now = options.now ?? new Date();

  const dupes = (values: string[], path: string, what: string) => {
    const seen = new Set<string>();
    values.forEach((v, i) => {
      if (seen.has(v)) err("DUPLICATE", `${path}.${i}`, `Duplicate ${what} "${v}"`);
      seen.add(v);
    });
  };
  dupes(config.groups.map((g) => g.id), "groups", "group id");
  dupes(config.groups.map((g) => g.key), "groups", "group key");
  dupes(config.rounds.map((r) => r.id), "rounds", "round id");
  dupes(config.rounds.map((r) => r.key), "rounds", "round key");
  const allIds = [...config.groups.map((g) => g.id), ...config.rounds.map((r) => r.id)];
  if (new Set(allIds).size !== allIds.length) err("DUPLICATE", "", "Rounds and groups must not share ids");

  const groupIds = new Set(config.groups.map((g) => g.id));
  config.groups.forEach((g, gi) => {
    const path = `groups.${gi}.eligibility`;
    if (eligibilityDepth(g.eligibility) > 4) err("ELIGIBILITY_TOO_DEEP", path, "Eligibility rules may nest at most 4 levels");
    checkEligibility(g.eligibility, path, err);
  });

  config.rounds.forEach((r, ri) => {
    const path = `rounds.${ri}`;
    const opens = Date.parse(r.opensAt);
    const closes = Date.parse(r.closesAt);
    if (closes <= opens) err("WINDOW_INVALID", `${path}.closesAt`, "A round must close after it opens");
    if (opens < now.getTime() && !options.published) warn("OPENS_IN_PAST", `${path}.opensAt`, "This round opens in the past");

    const seen = new Set<string>();
    r.groups.forEach((rg, gi) => {
      if (!groupIds.has(rg.groupId)) err("UNKNOWN_GROUP", `${path}.groups.${gi}.groupId`, "Refers to a group that does not exist");
      if (seen.has(rg.groupId)) err("DUPLICATE", `${path}.groups.${gi}.groupId`, "Group listed twice in this round");
      seen.add(rg.groupId);
      const q = rg.qualification;
      if (q) {
        if (r.kind === "practice") err("PRACTICE_QUALIFICATION", `${path}.groups.${gi}.qualification`, "Practice rounds never affect official results");
        if (q.criteria.length === 0 && q.maxWildcards === 0) err("QUALIFICATION_EMPTY", `${path}.groups.${gi}.qualification`, "Add at least one criterion or allow wildcards");
      }
      const tbs = rg.ranking.tieBreakers;
      if (new Set(tbs).size !== tbs.length) err("DUPLICATE", `${path}.groups.${gi}.ranking.tieBreakers`, "Each tie-breaker may appear once");
    });
    if (!r.groups.some((g) => g.enabled)) err("NO_ENABLED_GROUP", `${path}.groups`, "Enable at least one group in this round");
    if (r.kind !== "practice" && r.attemptPolicy.maxAttempts === null) {
      warn("UNLIMITED_OFFICIAL_ATTEMPTS", `${path}.attemptPolicy.maxAttempts`, "Unlimited attempts in an official round");
    }

    if (r.entry.type === "qualified_from") {
      const entry = r.entry;
      const si = config.rounds.findIndex((x) => x.id === entry.roundId);
      const source = config.rounds[si];
      if (!source) err("UNKNOWN_ROUND", `${path}.entry.roundId`, "Refers to a round that does not exist");
      else if (si >= ri) err("ROUND_ORDER", `${path}.entry.roundId`, "A round can only take qualifiers from an earlier round");
      else {
        if (source.kind === "practice") err("PRACTICE_SOURCE", `${path}.entry.roundId`, "Practice rounds cannot qualify anyone");
        if (Date.parse(source.closesAt) > opens) err("OPENS_BEFORE_SOURCE_CLOSES", `${path}.opensAt`, "This round opens before the qualifying round closes");
        for (const [gi, rg] of r.groups.entries()) {
          if (!rg.enabled) continue;
          const src = source.groups.find((g) => g.groupId === rg.groupId && g.enabled);
          if (!src) err("GROUP_NOT_IN_SOURCE", `${path}.groups.${gi}`, "This group is not enabled in the qualifying round");
          else if (!src.qualification) warn("SOURCE_HAS_NO_QUALIFICATION", `${path}.groups.${gi}`, "The qualifying round has no qualification rule for this group");
        }
      }
    }
  });

  if (options.published) checkAgainstPublished(config, options.published, now, err);
  return issues;
}

function checkEligibility(rule: EligibilityRule, path: string, err: (c: string, p: string, m: string) => void): void {
  switch (rule.type) {
    case "all":
    case "any":
      rule.rules.forEach((r, i) => checkEligibility(r, `${path}.rules.${i}`, err));
      return;
    case "age":
    case "grade_level":
      if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) err("RANGE_INVALID", path, "Minimum is greater than maximum");
      return;
    case "birth_date":
      if (rule.from && rule.to && rule.from > rule.to) err("RANGE_INVALID", path, "'from' is after 'to'");
      return;
    default:
      return;
  }
}

/**
 * A round that has already opened is locked in the published version: it
 * cannot be removed or changed by publishing a new planned version. Live
 * changes go through audited emergency actions instead (stage 6).
 */
function checkAgainstPublished(
  config: CompetitionConfig,
  published: CompetitionConfig,
  now: Date,
  err: (c: string, p: string, m: string) => void,
): void {
  for (const old of published.rounds) {
    if (Date.parse(old.opensAt) > now.getTime()) continue;
    const ri = config.rounds.findIndex((r) => r.id === old.id);
    if (ri === -1) {
      err("ROUND_LOCKED", "rounds", `Round "${old.key}" has already opened and cannot be removed`);
      continue;
    }
    if (JSON.stringify(config.rounds[ri]) !== JSON.stringify(old)) {
      err("ROUND_LOCKED", `rounds.${ri}`, `Round "${old.key}" has already opened; use an emergency action to change it`);
    }
  }
  for (const old of published.groups) {
    const g = config.groups.find((x) => x.id === old.id);
    const openedUsingGroup = published.rounds.some(
      (r) => Date.parse(r.opensAt) <= now.getTime() && r.groups.some((rg) => rg.groupId === old.id && rg.enabled),
    );
    if (!openedUsingGroup) continue;
    if (!g) err("GROUP_LOCKED", "groups", `Group "${old.key}" is in a round that has opened and cannot be removed`);
    else if (JSON.stringify(g.eligibility) !== JSON.stringify(old.eligibility)) {
      err("GROUP_LOCKED", `groups.${config.groups.indexOf(g)}.eligibility`, `Eligibility of "${old.key}" cannot change after its round opened`);
    }
  }
}

export const hasErrors = (issues: readonly ConfigIssue[]): boolean => issues.some((i) => i.severity === "error");
