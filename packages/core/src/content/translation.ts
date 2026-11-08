import type { ContentItemData, ItemBody } from "./items.ts";

/**
 * Translations are stored separately from items as a map of
 * "string path" → text. Only display strings are translatable; answers,
 * pronunciation targets and ids are not (a Mandarin reading exercise keeps its
 * Mandarin target text in every interface language).
 *
 * A translation records a hash of the base strings it was made from, so it
 * becomes "stale" as soon as the source text changes.
 */
export type TranslationStrings = Record<string, string>;

export function translatableStrings(item: Pick<ContentItemData, "contentType" | "body" | "explanation">): TranslationStrings {
  const out: TranslationStrings = {};
  const b = item.body as Record<string, unknown> & ItemBody;
  out.prompt = (b as { prompt: string }).prompt;
  const list = (key: string, field = "text") => {
    for (const x of (b[key] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof x[field] === "string") out[`${key}.${x.id as string}.${field}`] = x[field] as string;
    }
  };
  list("options");
  list("left");
  list("right");
  list("items");
  list("targets");
  list("draggables");
  for (const m of (b.promptMedia as Array<{ altText?: string }> | undefined) ?? []) {
    const i = (b.promptMedia as unknown[]).indexOf(m);
    if (m.altText) out[`promptMedia.${i}.altText`] = m.altText;
  }
  if (item.explanation) out.explanation = item.explanation;
  return out;
}

/** Order-independent hash of the base strings (cyrb53; change detection, not security). */
export function sourceHash(strings: TranslationStrings): string {
  const str = Object.keys(strings).sort().map((k) => `${k}\u0000${strings[k]}`).join("\u0001");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export interface TranslationCheck {
  unknownPaths: string[];
  missingPaths: string[];
}

export function checkTranslation(item: Pick<ContentItemData, "contentType" | "body" | "explanation">, strings: TranslationStrings): TranslationCheck {
  const base = translatableStrings(item);
  return {
    unknownPaths: Object.keys(strings).filter((k) => !(k in base)).sort(),
    missingPaths: Object.keys(base).filter((k) => !strings[k]?.trim()).sort(),
  };
}

/** The item as shown in one locale: translated strings overlaid, base text where missing. */
export function localizeItem<T extends Pick<ContentItemData, "contentType" | "body" | "explanation">>(item: T, strings: TranslationStrings | null): T {
  if (!strings) return item;
  const body = structuredClone(item.body) as Record<string, unknown>;
  const pick = (path: string, fallback: string) => strings[path]?.trim() || fallback;
  body.prompt = pick("prompt", body.prompt as string);
  for (const key of ["options", "left", "right", "items", "targets", "draggables"]) {
    const arr = body[key] as Array<Record<string, unknown>> | undefined;
    for (const x of arr ?? []) if (typeof x.text === "string") x.text = pick(`${key}.${x.id as string}.text`, x.text);
  }
  (body.promptMedia as Array<{ altText?: string }> | undefined)?.forEach((m, i) => {
    if (m.altText) m.altText = pick(`promptMedia.${i}.altText`, m.altText);
  });
  return { ...item, body: body as unknown as T["body"], explanation: item.explanation ? pick("explanation", item.explanation) : item.explanation };
}
