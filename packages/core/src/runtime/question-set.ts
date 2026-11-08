import type { QuestionType, RoundGroupConfig } from "../competition/config.ts";
import type { ContentItemData } from "../content/items.ts";
import { matchingItems } from "../content/pool.ts";
import { localizeItem, type TranslationStrings } from "../content/translation.ts";
import { rng, seedFrom, shuffle } from "./random.ts";

/** One question as frozen into an attempt: which item, and the display order of its parts. */
export interface QuestionRef {
  itemId: string;
  /** Display order of options / right column / items / draggables, by id. */
  order: Record<string, string[]>;
}

export interface PoolItem {
  itemId: string;
  externalKey: string;
  contentType: QuestionType;
  difficulty: ContentItemData["difficulty"];
  category: string | null;
  tags: string[];
  locales: string[];
  item: ContentItemData;
}

// Parts whose stored order would give the answer away are always shuffled.
const ALWAYS_SHUFFLED: Partial<Record<QuestionType, string[]>> = {
  matching: ["right"],
  ordering: ["items"],
  drag_drop: ["draggables"],
};
const OPTION_TYPES = new Set<QuestionType>(["single_choice", "multiple_choice", "image_choice", "audio_choice", "listen_select"]);

/**
 * Pick and order the questions for one attempt, deterministically from the seed.
 *   fixed:            the first N matching items by content id (same set for everyone)
 *   random_from_pool: N items drawn from the matching pool per participant
 * Question order and option order are shuffled when the round-group asks for it.
 */
export interface QuestionSetOptions {
  /** Items never given (disabled or replaced by an emergency action). */
  exclude?: ReadonlySet<string>;
  /** Items always included (replacements), taking places from the rest. */
  require?: readonly string[];
}

export function buildQuestionSet(
  pool: readonly PoolItem[],
  rg: Pick<RoundGroupConfig, "questionFormats" | "questionCount" | "content" | "randomizeQuestions" | "randomizeOptions">,
  seedText: string,
  options: QuestionSetOptions = {},
): QuestionRef[] {
  const random = rng(seedFrom(seedText));
  const required = new Set(options.require ?? []);
  const available = pool.filter((p) => !options.exclude?.has(p.itemId) || required.has(p.itemId));
  const matching = matchingItems(available, rg.questionFormats, rg.content.filters) as PoolItem[];
  const forced = available.filter((p) => required.has(p.itemId)).sort((a, b) => a.externalKey.localeCompare(b.externalKey));
  const sorted = [...matching].filter((p) => !required.has(p.itemId)).sort((a, b) => a.externalKey.localeCompare(b.externalKey));
  const count = Math.min(rg.questionCount ?? sorted.length + forced.length, sorted.length + forced.length);
  const rest = count - Math.min(forced.length, count);
  let chosen = [
    ...forced.slice(0, count),
    ...(rg.content.selection === "random_from_pool" ? shuffle(sorted, random).slice(0, rest) : sorted.slice(0, rest)),
  ];
  if (!rg.randomizeQuestions) chosen = chosen.sort((a, b) => a.externalKey.localeCompare(b.externalKey));
  if (rg.randomizeQuestions) chosen = shuffle(chosen, random);
  return chosen.map((p) => {
    const body = p.item.body as Record<string, unknown>;
    const order: Record<string, string[]> = {};
    const parts = [...(ALWAYS_SHUFFLED[p.contentType] ?? []), ...(OPTION_TYPES.has(p.contentType) ? ["options"] : [])];
    for (const part of parts) {
      const ids = ((body[part] as Array<{ id: string }> | undefined) ?? []).map((x) => x.id);
      const shuffleIt = part !== "options" || rg.randomizeOptions;
      order[part] = shuffleIt ? shuffleUntilChanged(ids, random) : ids;
    }
    return { itemId: p.itemId, order };
  });
}

/** Shuffle, retrying a few times so a revealing part rarely stays in answer order. */
function shuffleUntilChanged(ids: string[], random: () => number): string[] {
  if (ids.length < 2) return ids;
  let out = shuffle(ids, random);
  for (let i = 0; i < 5 && out.every((id, k) => id === ids[k]); i++) out = shuffle(ids, random);
  return out;
}

/**
 * What the participant's browser receives for one question: localized,
 * reordered, and with every answer removed.
 */
export function participantView(item: ContentItemData, ref: QuestionRef, translation: TranslationStrings | null) {
  const localized = localizeItem(item, translation);
  const b = localized.body as Record<string, unknown>;
  const reorder = (part: string) => {
    const list = (b[part] as Array<{ id: string }> | undefined) ?? [];
    const order = ref.order[part];
    if (!order) return list;
    const byId = new Map(list.map((x) => [x.id, x]));
    return order.map((id) => byId.get(id)).filter(Boolean);
  };
  const base = { itemId: ref.itemId, contentType: item.contentType, points: item.points, prompt: b.prompt, promptMedia: b.promptMedia ?? [] };
  switch (item.contentType) {
    case "single_choice":
    case "image_choice":
    case "audio_choice":
    case "listen_select":
      return { ...base, options: reorder("options") };
    case "multiple_choice":
      return { ...base, options: reorder("options"), selectCount: (b.correctOptionIds as string[]).length };
    case "true_false":
      return base;
    case "matching":
      return { ...base, left: b.left, right: reorder("right") };
    case "ordering":
      return { ...base, items: reorder("items") };
    case "text_input":
      return base;
    case "fill_blank":
      return { ...base, blanks: (b.blanks as Array<{ id: string }>).map((x) => ({ id: x.id })) };
    case "pronunciation":
      return { ...base, targetText: b.targetText, speechLanguage: b.speechLanguage, romanization: b.romanization ?? null, referenceAudio: b.referenceAudio ?? null, maxRecordingSeconds: b.maxRecordingSeconds };
    case "drag_drop":
      return { ...base, targets: b.targets, draggables: reorder("draggables") };
    case "custom":
      // Custom data is passed through as configured; it must not contain the answer.
      return { ...base, customType: b.customType, data: b.data };
  }
}
