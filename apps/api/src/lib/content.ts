import {
  checkTranslation,
  parseContentItem,
  sourceHash,
  translatableStrings,
  type ContentItemData,
  type ItemIssue,
  type TranslationStrings,
} from "@cos/core";
import type { ContentBank, ContentItem, ContentItemTranslation, Tx } from "@cos/db";

/** Stored row → validated item data (re-parsed, so stored rows are always checked against the current schema). */
export function rowToInput(row: ContentItem): Record<string, unknown> {
  return {
    externalKey: row.external_key,
    contentType: row.content_type,
    baseLocale: row.base_locale,
    difficulty: row.difficulty,
    points: Number(row.points),
    category: row.category,
    tags: row.tags,
    explanation: row.explanation,
    explanationMedia: row.explanation_media,
    sourceReference: row.source_reference,
    skillIds: row.skill_ids,
    objectiveIds: row.objective_ids,
    body: row.body,
  };
}

export function rowToData(row: ContentItem): ContentItemData {
  const parsed = parseContentItem(rowToInput(row));
  if (!parsed.ok) throw new Error(`stored item ${row.id} no longer validates: ${JSON.stringify(parsed.issues)}`);
  return parsed.item;
}

export function dataToRow(item: ContentItemData) {
  return {
    external_key: item.externalKey,
    content_type: item.contentType,
    base_locale: item.baseLocale,
    difficulty: item.difficulty,
    points: item.points,
    category: item.category,
    tags: item.tags,
    explanation: item.explanation,
    explanation_media: JSON.stringify(item.explanationMedia),
    source_reference: item.sourceReference,
    skill_ids: item.skillIds,
    objective_ids: item.objectiveIds,
    body: JSON.stringify(item.body),
  };
}

export const itemHash = (item: Pick<ContentItemData, "contentType" | "body" | "explanation">): string => sourceHash(translatableStrings(item));

export interface BankRefs {
  skills: Map<string, { id: string; key: string; status: string }>;
  skillsByKey: Map<string, { id: string; key: string; status: string }>;
  objectives: Map<string, { id: string; key: string; status: string }>;
  objectivesByKey: Map<string, { id: string; key: string; status: string }>;
}

/** Skills from the bank's framework and the bank's learning objectives. */
export async function loadBankRefs(tx: Tx, bank: ContentBank): Promise<BankRefs> {
  const skills = bank.skill_framework_id
    ? await tx.selectFrom("skills").select(["id", "key", "status"]).where("framework_id", "=", bank.skill_framework_id).execute()
    : [];
  const objectives = await tx.selectFrom("learning_objectives").select(["id", "key", "status"]).where("bank_id", "=", bank.id).execute();
  return {
    skills: new Map(skills.map((s) => [s.id, s])),
    skillsByKey: new Map(skills.map((s) => [s.key.toLowerCase(), s])),
    objectives: new Map(objectives.map((o) => [o.id, o])),
    objectivesByKey: new Map(objectives.map((o) => [o.key.toLowerCase(), o])),
  };
}

export function checkRefs(item: Pick<ContentItemData, "skillIds" | "objectiveIds">, refs: BankRefs): ItemIssue[] {
  const issues: ItemIssue[] = [];
  item.skillIds.forEach((id, i) => {
    const s = refs.skills.get(id);
    if (!s) issues.push({ path: `skillIds.${i}`, message: "Skill is not in this bank's skill framework" });
    else if (s.status !== "active") issues.push({ path: `skillIds.${i}`, message: `Skill "${s.key}" is archived` });
  });
  item.objectiveIds.forEach((id, i) => {
    const o = refs.objectives.get(id);
    if (!o) issues.push({ path: `objectiveIds.${i}`, message: "Learning objective is not in this bank" });
    else if (o.status !== "active") issues.push({ path: `objectiveIds.${i}`, message: `Objective "${o.key}" is archived` });
  });
  return issues;
}

export interface TranslationState {
  locale: string;
  status: "draft" | "approved";
  /** The base text changed after this translation was made. */
  stale: boolean;
  missingPaths: string[];
}

export function translationState(item: ContentItemData, t: ContentItemTranslation): TranslationState {
  const strings = t.strings as TranslationStrings;
  return {
    locale: t.locale,
    status: t.status,
    stale: t.source_hash !== itemHash(item),
    missingPaths: checkTranslation(item, strings).missingPaths,
  };
}

/** Approved translations that still match the current base text. */
export function currentTranslations(item: ContentItemData, translations: readonly ContentItemTranslation[]): Record<string, TranslationStrings> {
  const hash = itemHash(item);
  return Object.fromEntries(
    translations.filter((t) => t.status === "approved" && t.source_hash === hash).map((t) => [t.locale, t.strings as TranslationStrings]),
  );
}

export function presentItem(row: ContentItem, translations: readonly ContentItemTranslation[] = []) {
  const data = rowToData(row);
  return {
    id: row.id,
    ...data,
    status: row.status,
    revision: row.revision,
    updatedAt: row.updated_at,
    translations: translations.filter((t) => t.item_id === row.id).map((t) => translationState(data, t)),
  };
}

export function presentBank(b: ContentBank) {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    nameI18n: b.name_i18n,
    descriptionI18n: b.description_i18n,
    baseLocale: b.base_locale,
    requiredLocales: b.required_locales,
    skillFrameworkId: b.skill_framework_id,
    practiceEnabled: b.practice_enabled,
    status: b.status,
    createdAt: b.created_at,
  };
}
