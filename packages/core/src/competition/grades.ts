/**
 * Grade levels. Eligibility needs to compare grades across education systems,
 * so grades are normalized to a "grade level" integer:
 *
 *   Kindergarten K1/K2/K3 = -2/-1/0, Primary 1..6 = 1..6, Secondary 1..6 = 7..12
 *
 * This lines up Hong Kong (P1-P6, S1-S6/F1-F6), mainland China (小一..., 初一-初三,
 * 高一-高三), Thailand (อ.1-3, ป.1-6, ม.1-6) and US-style Grade 1-12.
 * Unrecognized grades return null; eligibility then reports MISSING_GRADE
 * rather than guessing.
 */
const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

export function parseGradeLevel(input: string | null | undefined): number | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/\s+/g, " ");

  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:K|KG|KINDERGARTEN)\s?\.?\s?([1-3])$/))) return Number(m[1]) - 3;
  if (s === "K" || s === "KG" || s === "KINDERGARTEN") return 0;
  if ((m = s.match(/^(?:P|PRIMARY|G|GR|GRADE|Y|YEAR)\s?\.?\s?(\d{1,2})$/))) {
    const n = Number(m[1]);
    const isPrimary = /^P/.test(s);
    if (isPrimary ? n >= 1 && n <= 6 : n >= 1 && n <= 12) return n;
    return null;
  }
  if ((m = s.match(/^(?:S|F|M|SECONDARY|FORM)\s?\.?\s?([1-6])$/))) return 6 + Number(m[1]);

  // Thai: อ.1-3 (kindergarten), ป.1-6 (primary), ม.1-6 (secondary)
  if ((m = raw.match(/^อ\s?\.?\s?([1-3])$/))) return Number(m[1]) - 3;
  if ((m = raw.match(/^ป\s?\.?\s?([1-6])$/))) return Number(m[1]);
  if ((m = raw.match(/^ม\s?\.?\s?([1-6])$/))) return 6 + Number(m[1]);

  // Chinese: 小一-小六, 中一-中六 (HK), 初一-初三, 高一-高三 (mainland), K1-3 as 幼兒班/低班/高班 is not attempted.
  if ((m = raw.match(/^小([一二三四五六])$/))) return CN_DIGITS[m[1]!]!;
  if ((m = raw.match(/^中([一二三四五六])$/))) return 6 + CN_DIGITS[m[1]!]!;
  if ((m = raw.match(/^初([一二三])$/))) return 6 + CN_DIGITS[m[1]!]!;
  if ((m = raw.match(/^高([一二三])$/))) return 9 + CN_DIGITS[m[1]!]!;
  return null;
}
