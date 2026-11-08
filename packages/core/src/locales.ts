/**
 * Locales. Interface language and content language are independent: a user's
 * interface locale lives on the user; content locales live on content items.
 */
export const LOCALES = ["en", "zh-Hant", "zh-Hans", "th"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Map a BCP 47 tag (zh-HK, zh-TW, zh-CN, th-TH, en-GB, ...) to a supported locale. */
export function normalizeLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("zh")) {
    if (t.includes("hant") || /-(hk|tw|mo)\b/.test(t)) return "zh-Hant";
    return "zh-Hans";
  }
  if (t.startsWith("th")) return "th";
  if (t.startsWith("en")) return "en";
  return null;
}

/** Pick the best supported locale from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | undefined): Locale | null {
  if (!acceptLanguage) return null;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag ?? "", q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const locale = normalizeLocale(tag);
    if (locale) return locale;
  }
  return null;
}
