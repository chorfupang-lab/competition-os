import { LOCALES, checkTranslation, isLocale, parseContentItem, type ContentItemData, type TranslationStrings } from "@cos/core";
import type { ContentBank, ContentItem, ContentItemTranslation, Tx } from "@cos/db";
import { checkRefs, loadBankRefs, rowToData } from "./content.ts";
import type { ImportError, ParsedWorkbook } from "./excel.ts";

export interface PlannedItem {
  action: "create" | "update" | "unchanged";
  existingId: string | null;
  status: "ready" | "draft";
  item: ContentItemData;
}

export interface PlannedTranslation {
  externalKey: string;
  locale: string;
  /** Merged with any existing translation for this item and locale. */
  strings: TranslationStrings;
  status: "draft" | "approved";
}

export interface ImportPlan {
  items: PlannedItem[];
  translations: PlannedTranslation[];
  errors: ImportError[];
  summary: { create: number; update: number; unchanged: number; translations: number; errors: number };
}

/**
 * Validate a parsed workbook against the bank as it is now. Used for the
 * preview and again at commit, so a commit never applies a stale plan.
 */
export async function planImport(tx: Tx, bank: ContentBank, parsed: ParsedWorkbook): Promise<ImportPlan> {
  const errors: ImportError[] = [...parsed.errors];
  const refs = await loadBankRefs(tx, bank);
  const existingRows = await tx.selectFrom("content_items").selectAll().where("bank_id", "=", bank.id).execute();
  const existing = new Map<string, ContentItem>(existingRows.map((r) => [r.external_key.toLowerCase(), r]));

  const items: PlannedItem[] = [];
  const seen = new Map<string, string>();
  for (const row of parsed.items) {
    const at = { sheet: row.sheet, row: row.row };
    const key = String(row.input.externalKey ?? "").toLowerCase();
    if (!key) {
      errors.push({ ...at, field: "content_id", message: "content_id is required" });
      continue;
    }
    const dup = seen.get(key);
    if (dup) {
      errors.push({ ...at, field: "content_id", message: `content_id also used at ${dup}` });
      continue;
    }
    seen.set(key, `${row.sheet} row ${row.row}`);

    const skillIds: string[] = [];
    let refError = false;
    for (const k of row.skillKeys) {
      const s = refs.skillsByKey.get(k);
      if (!s) {
        errors.push({ ...at, field: "skills", message: bank.skill_framework_id ? `Unknown skill "${k}"` : "This bank has no skill framework" });
        refError = true;
      } else skillIds.push(s.id);
    }
    const objectiveIds: string[] = [];
    for (const k of row.objectiveKeys) {
      const o = refs.objectivesByKey.get(k);
      if (!o) {
        errors.push({ ...at, field: "objectives", message: `Unknown learning objective "${k}"` });
        refError = true;
      } else objectiveIds.push(o.id);
    }
    const result = parseContentItem({ ...row.input, skillIds, objectiveIds });
    if (!result.ok) {
      for (const issue of result.issues) errors.push({ ...at, field: issue.path, message: issue.message });
      continue;
    }
    for (const issue of checkRefs(result.item, refs)) errors.push({ ...at, field: issue.path, message: issue.message });
    if (refError) continue;

    const prior = existing.get(key);
    let action: PlannedItem["action"] = "create";
    if (prior) {
      const same = JSON.stringify(rowToData(prior)) === JSON.stringify(result.item) && prior.status === row.status;
      if (prior.content_type !== result.item.contentType) {
        errors.push({ ...at, field: "content_id", message: `content_id already belongs to a ${prior.content_type} question` });
        continue;
      }
      action = same ? "unchanged" : "update";
    }
    items.push({ action, existingId: prior?.id ?? null, status: row.status, item: result.item });
  }

  // Translations: group rows by item and locale, merge onto existing strings.
  const fileItems = new Map(items.map((p) => [p.item.externalKey.toLowerCase(), p.item]));
  const existingTranslations = existingRows.length
    ? await tx.selectFrom("content_item_translations").selectAll().where("item_id", "in", existingRows.map((r) => r.id)).execute()
    : [];
  const byItemLocale = new Map<string, ContentItemTranslation>(existingTranslations.map((t) => [`${t.item_id}|${t.locale}`, t]));
  const groups = new Map<string, { externalKey: string; locale: string; rows: ParsedWorkbook["translations"] }>();
  for (const t of parsed.translations) {
    const k = `${t.externalKey.toLowerCase()}|${t.locale}`;
    const g = groups.get(k) ?? { externalKey: t.externalKey, locale: t.locale, rows: [] };
    g.rows.push(t);
    groups.set(k, g);
  }
  const translations: PlannedTranslation[] = [];
  for (const g of groups.values()) {
    const first = g.rows[0]!;
    const at = { sheet: first.sheet, row: first.row };
    const ek = g.externalKey.toLowerCase();
    const prior = existing.get(ek);
    const item = fileItems.get(ek) ?? (prior ? rowToData(prior) : null);
    if (!item) {
      if (!seen.has(ek)) errors.push({ ...at, field: "content_id", message: `Unknown content_id "${g.externalKey}"` });
      continue;
    }
    if (!isLocale(g.locale)) {
      errors.push({ ...at, field: "locale", message: `locale must be one of ${LOCALES.join(", ")}` });
      continue;
    }
    if (g.locale === item.baseLocale) {
      errors.push({ ...at, field: "locale", message: "This is the question's base language; edit the question itself" });
      continue;
    }
    const before = prior ? (byItemLocale.get(`${prior.id}|${g.locale}`)?.strings as TranslationStrings | undefined) : undefined;
    const strings: TranslationStrings = { ...(before ?? {}) };
    for (const r of g.rows) strings[r.field] = r.text;
    const check = checkTranslation(item, strings);
    for (const p of check.unknownPaths) {
      const r = g.rows.find((x) => x.field === p);
      errors.push({ sheet: r?.sheet ?? at.sheet, row: r?.row ?? at.row, field: "field", message: `"${p}" is not a text of this question` });
    }
    const approved = g.rows.every((r) => r.status === "approved");
    if (approved && check.missingPaths.length > 0) {
      errors.push({ ...at, field: "status", message: `Approved translation is missing: ${check.missingPaths.join(", ")}` });
    }
    translations.push({ externalKey: item.externalKey, locale: g.locale, strings, status: approved ? "approved" : "draft" });
  }

  errors.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row);
  return {
    items,
    translations,
    errors,
    summary: {
      create: items.filter((i) => i.action === "create").length,
      update: items.filter((i) => i.action === "update").length,
      unchanged: items.filter((i) => i.action === "unchanged").length,
      translations: translations.length,
      errors: errors.length,
    },
  };
}
