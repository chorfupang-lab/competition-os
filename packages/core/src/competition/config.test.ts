import { describe, expect, it } from "vitest";
import { CompetitionConfigSchema, diffConfigs, hasErrors, standardTemplate, validateConfig, type CompetitionConfig } from "./index.ts";

const NOW = new Date("2026-11-01T00:00:00Z");
const clone = (c: CompetitionConfig): CompetitionConfig => structuredClone(c);
const codes = (c: CompetitionConfig, opts = {}) => validateConfig(c, { now: NOW, ...opts }).map((i) => `${i.severity}:${i.code}`);

describe("standard template", () => {
  it("is valid and has the four default groups and two rounds", () => {
    const t = standardTemplate(NOW);
    expect(t.groups.map((g) => g.key)).toEqual(["kindergarten", "primary", "secondary", "open"]);
    expect(t.rounds.map((r) => r.kind)).toEqual(["qualifying", "final"]);
    expect(validateConfig(t, { now: NOW })).toEqual([]);
    expect(t.rounds[0]!.groups[0]!.scoring.correctPoints).toBe("item");
  });
});

describe("config validation", () => {
  it("rejects unknown fields' types and bad references at the schema level", () => {
    const t = standardTemplate(NOW) as unknown as Record<string, unknown>;
    const bad = { ...t, rounds: [{ ...(t.rounds as object[])[0], kind: "semi" }] };
    expect(CompetitionConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("catches semantic errors", () => {
    const c = clone(standardTemplate(NOW));
    c.rounds[0]!.closesAt = c.rounds[0]!.opensAt;
    c.rounds[0]!.groups.forEach((g) => (g.enabled = false));
    c.groups[1]!.key = c.groups[0]!.key;
    c.rounds[1]!.groups[0]!.groupId = crypto.randomUUID();
    expect(codes(c)).toEqual(expect.arrayContaining(["error:WINDOW_INVALID", "error:NO_ENABLED_GROUP", "error:DUPLICATE", "error:UNKNOWN_GROUP"]));
  });

  it("requires a qualifying round to close before the next round opens", () => {
    const c = clone(standardTemplate(NOW));
    c.rounds[1]!.opensAt = c.rounds[0]!.opensAt;
    expect(codes(c)).toContain("error:OPENS_BEFORE_SOURCE_CLOSES");
  });

  it("keeps practice rounds out of qualification", () => {
    const c = clone(standardTemplate(NOW));
    c.rounds[0]!.kind = "practice";
    expect(codes(c)).toEqual(expect.arrayContaining(["error:PRACTICE_QUALIFICATION", "error:PRACTICE_SOURCE"]));
  });

  it("warns about unlimited official attempts", () => {
    const c = clone(standardTemplate(NOW));
    c.rounds[0]!.attemptPolicy.maxAttempts = null;
    const issues = validateConfig(c, { now: NOW });
    expect(issues.map((i) => `${i.severity}:${i.code}`)).toEqual(["warning:UNLIMITED_OFFICIAL_ATTEMPTS"]);
    expect(hasErrors(issues)).toBe(false);
  });

  it("locks rounds that have opened against planned changes", () => {
    const published = clone(standardTemplate(NOW));
    const afterOpen = new Date(Date.parse(published.rounds[0]!.opensAt) + 1000);
    const next = clone(published);
    // Changing the open round is blocked; changing the future final is fine.
    next.rounds[1]!.groups[0]!.questionCount = 40;
    expect(validateConfig(next, { now: afterOpen, published })).toEqual([]);
    next.rounds[0]!.groups[0]!.durationSeconds = 600;
    expect(codes(next, { now: afterOpen, published })).toContain("error:ROUND_LOCKED");
    const removed = clone(published);
    removed.groups[0]!.eligibility = { type: "open" };
    expect(codes(removed, { now: afterOpen, published })).toContain("error:GROUP_LOCKED");
  });
});

describe("diff", () => {
  it("reports added, removed and changed rounds and groups by key", () => {
    const a = standardTemplate(NOW);
    const b = clone(a);
    b.groups.pop();
    b.rounds[1]!.closesAt = "2027-01-01T00:00:00Z";
    b.groups.push({ id: crypto.randomUUID(), key: "adult", name: { en: "Adult" }, eligibility: { type: "age", min: 18, asOf: "2026-12-31" }, capacity: null });
    expect(diffConfigs(a, b)).toEqual({
      groups: { added: ["adult"], removed: ["open"], changed: [] },
      rounds: { added: [], removed: [], changed: ["final"] },
    });
  });
});
