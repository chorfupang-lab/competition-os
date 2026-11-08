import type { CompetitionConfig, QuestionType } from "../competition/config.ts";
import type { Difficulty } from "../competition/scoring.ts";
import type { ConfigIssue } from "../competition/validate.ts";

/**
 * Checks a competition's content references against published Content Bank
 * Versions: the version must exist in the tenant, and the items that match a
 * round-group's question formats and filters must cover its question count.
 */
export interface VersionItemSummary {
  contentType: QuestionType;
  difficulty: Difficulty;
  category: string | null;
  tags: string[];
  /** Locales with an approved, current translation, plus the base locale. */
  locales: string[];
}

export interface ContentFilters {
  difficulties?: Difficulty[] | undefined;
  categories?: string[] | undefined;
  tags?: string[] | undefined;
}

export function matchingItems(items: readonly VersionItemSummary[], formats: readonly QuestionType[], filters: ContentFilters = {}): VersionItemSummary[] {
  return items.filter(
    (i) =>
      formats.includes(i.contentType) &&
      (!filters.difficulties?.length || filters.difficulties.includes(i.difficulty)) &&
      (!filters.categories?.length || (i.category !== null && filters.categories.includes(i.category))) &&
      (!filters.tags?.length || filters.tags.some((t) => i.tags.includes(t.toLowerCase()))),
  );
}

export function validateContentReferences(
  config: CompetitionConfig,
  versions: ReadonlyMap<string, readonly VersionItemSummary[]>,
  contentLocales: readonly string[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  config.rounds.forEach((r, ri) => {
    r.groups.forEach((rg, gi) => {
      if (!rg.enabled) return;
      const path = `rounds.${ri}.groups.${gi}.content`;
      const vid = rg.content.contentBankVersionId;
      if (!vid) {
        issues.push({ severity: "warning", code: "NO_CONTENT", path, message: "No content bank version selected yet" });
        return;
      }
      const items = versions.get(vid);
      if (!items) {
        issues.push({ severity: "error", code: "UNKNOWN_CONTENT_VERSION", path: `${path}.contentBankVersionId`, message: "Content bank version not found in this organization" });
        return;
      }
      const pool = matchingItems(items, rg.questionFormats, rg.content.filters);
      const needed = rg.questionCount ?? pool.length;
      if (pool.length === 0 || pool.length < needed) {
        issues.push({
          severity: "error",
          code: "CONTENT_POOL_TOO_SMALL",
          path,
          message: `${pool.length} matching question(s) for ${needed} required`,
        });
      } else if (rg.content.selection === "random_from_pool" && pool.length === needed) {
        issues.push({ severity: "warning", code: "POOL_NOT_RANDOMIZABLE", path, message: "The pool is exactly the question count, so every participant gets the same questions" });
      }
      for (const locale of contentLocales) {
        const missing = pool.filter((i) => !i.locales.includes(locale)).length;
        if (missing > 0) {
          issues.push({ severity: "warning", code: "TRANSLATIONS_MISSING", path, message: `${missing} matching question(s) have no approved ${locale} version` });
        }
      }
    });
  });
  return issues;
}
