import type { CompetitionConfig } from "./config.ts";

/** What changed between two versions, by stable id. Stored in the audit log on publish. */
export interface ConfigDiff {
  groups: { added: string[]; removed: string[]; changed: string[] };
  rounds: { added: string[]; removed: string[]; changed: string[] };
}

export function diffConfigs(before: CompetitionConfig | null, after: CompetitionConfig): ConfigDiff {
  return {
    groups: diffById(before?.groups ?? [], after.groups),
    rounds: diffById(before?.rounds ?? [], after.rounds),
  };
}

function diffById<T extends { id: string; key: string }>(before: readonly T[], after: readonly T[]) {
  const b = new Map(before.map((x) => [x.id, x]));
  const a = new Map(after.map((x) => [x.id, x]));
  return {
    added: after.filter((x) => !b.has(x.id)).map((x) => x.key),
    removed: before.filter((x) => !a.has(x.id)).map((x) => x.key),
    changed: after.filter((x) => b.has(x.id) && JSON.stringify(b.get(x.id)) !== JSON.stringify(x)).map((x) => x.key),
  };
}
