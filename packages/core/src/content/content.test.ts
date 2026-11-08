import { describe, expect, it } from "vitest";
import { standardTemplate } from "../competition/template.ts";
import {
  checkTranslation,
  gradeResponse,
  localizeItem,
  matchingItems,
  normalizeAnswer,
  parseContentItem,
  sourceHash,
  toGradedItem,
  translatableStrings,
  validateContentReferences,
  type ContentItemData,
} from "./index.ts";

const base = { externalKey: "Q-1", baseLocale: "en", difficulty: "medium" };
const parse = (contentType: string, body: unknown, extra: Record<string, unknown> = {}): ContentItemData => {
  const r = parseContentItem({ ...base, contentType, body, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.item;
};
const issues = (contentType: string, body: unknown) => {
  const r = parseContentItem({ ...base, contentType, body });
  return r.ok ? [] : r.issues.map((i) => i.message);
};

const single = { prompt: "2 + 2 = ?", options: [{ id: "a", text: "3" }, { id: "b", text: "4" }], correctOptionId: "b" };
const img = (n: string) => ({ kind: "image", url: `https://cdn.example.com/${n}.png` });
const aud = (n: string) => ({ kind: "audio", url: `https://cdn.example.com/${n}.mp3` });

describe("item validation", () => {
  it("applies defaults and normalizes tags", () => {
    const item = parse("single_choice", single, { tags: ["Maths", "maths", "P4"] });
    expect(item).toMatchObject({ points: 1, category: null, tags: ["maths", "p4"], skillIds: [] });
  });

  it("rejects inconsistent answers for each type", () => {
    expect(issues("single_choice", { ...single, correctOptionId: "z" })).toContain("correctOptionId must be one of the options");
    expect(issues("multiple_choice", { ...single, correctOptionIds: ["a", "a"] })).toContain("correct ids must be unique");
    expect(issues("ordering", { prompt: "Order", items: [{ id: "1", text: "x" }, { id: "2", text: "y" }], correctOrder: ["1"] })).toContain(
      "correctOrder must list every item exactly once",
    );
    expect(issues("fill_blank", { prompt: "I [[a]] here", blanks: [{ id: "b", acceptedAnswers: ["am"] }] })).toContain(
      "every blank must appear in the prompt as [[id]]",
    );
    expect(issues("image_choice", single)).toContain("every option needs an image");
    expect(issues("listen_select", single)).toContain("the prompt needs an audio clip");
  });

  it("requires https media", () => {
    expect(issues("listen_select", { ...single, promptMedia: [{ kind: "audio", url: "http://insecure.example.com/a.mp3" }] }).length).toBeGreaterThan(0);
    expect(issues("listen_select", { ...single, promptMedia: [aud("q")] })).toEqual([]);
  });

  it("accepts all thirteen types", () => {
    const bodies: Record<string, unknown> = {
      single_choice: single,
      multiple_choice: { ...single, correctOptionIds: ["b"] },
      true_false: { prompt: "Sky is blue", answer: true },
      matching: { prompt: "Match", left: [{ id: "1", text: "貓" }, { id: "2", text: "狗" }], right: [{ id: "a", text: "cat" }, { id: "b", text: "dog" }], pairs: [{ leftId: "1", rightId: "a" }, { leftId: "2", rightId: "b" }] },
      ordering: { prompt: "Order", items: [{ id: "1", text: "one" }, { id: "2", text: "two" }], correctOrder: ["1", "2"] },
      image_choice: { prompt: "Which is a cat?", options: [{ id: "a", media: img("cat") }, { id: "b", media: img("dog") }], correctOptionId: "a" },
      audio_choice: { prompt: "Which says 媽?", options: [{ id: "a", media: aud("ma1") }, { id: "b", media: aud("ma3") }], correctOptionId: "a" },
      listen_select: { ...single, promptMedia: [aud("q")] },
      text_input: { prompt: "Capital of France", acceptedAnswers: ["Paris"] },
      fill_blank: { prompt: "我[[a]]學生", blanks: [{ id: "a", acceptedAnswers: ["是"] }] },
      pronunciation: { prompt: "Read aloud", targetText: "你好", speechLanguage: "cmn", romanization: "nǐ hǎo" },
      drag_drop: { prompt: "Sort", targets: [{ id: "fruit", text: "Fruit" }], draggables: [{ id: "apple", text: "Apple" }, { id: "car", text: "Car" }], placements: [{ draggableId: "apple", targetId: "fruit" }] },
      custom: { prompt: "Draw a stroke", customType: "stroke-order", data: { char: "永" } },
    };
    for (const [type, body] of Object.entries(bodies)) expect(issues(type, body), type).toEqual([]);
  });
});

describe("grading", () => {
  it("single choice", () => {
    const item = parse("single_choice", single);
    expect(gradeResponse(item, { optionId: "b" })).toEqual({ outcome: "correct", fraction: 1 });
    expect(gradeResponse(item, { optionId: "a" })).toEqual({ outcome: "incorrect", fraction: 0 });
    expect(gradeResponse(item, null)).toEqual({ outcome: "unanswered", fraction: 0 });
  });

  it("multiple choice with and without partial credit", () => {
    const opts = [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }, { id: "d", text: "4" }];
    const strict = parse("multiple_choice", { prompt: "Even?", options: opts, correctOptionIds: ["b", "d"] });
    const partial = parse("multiple_choice", { prompt: "Even?", options: opts, correctOptionIds: ["b", "d"], partialCredit: true });
    expect(gradeResponse(strict, { optionIds: ["d", "b"] }).outcome).toBe("correct");
    expect(gradeResponse(strict, { optionIds: ["b"] }).outcome).toBe("incorrect");
    expect(gradeResponse(partial, { optionIds: ["b"] })).toEqual({ outcome: "partial", fraction: 0.5 });
    expect(gradeResponse(partial, { optionIds: ["b", "a"] })).toEqual({ outcome: "incorrect", fraction: 0 });
  });

  it("text answers: full-width, case, spaces and trailing punctuation", () => {
    expect(normalizeAnswer("  ＰＡＲＩＳ。 ", { caseSensitive: false, ignoreSpaces: false })).toBe("paris");
    const item = parse("text_input", { prompt: "Say hello", acceptedAnswers: ["ni hao", "你好"], ignoreSpaces: true });
    expect(gradeResponse(item, { text: "Nihao!" }).outcome).toBe("correct");
    expect(gradeResponse(item, { text: "你 好" }).outcome).toBe("correct");
    const cs = parse("text_input", { prompt: "Symbol for sodium", acceptedAnswers: ["Na"], caseSensitive: true });
    expect(gradeResponse(cs, { text: "na" }).outcome).toBe("incorrect");
  });

  it("matching, ordering, fill-blank and drag-drop give partial fractions", () => {
    const m = parse("matching", { prompt: "M", left: [{ id: "1", text: "a" }, { id: "2", text: "b" }], right: [{ id: "x", text: "A" }, { id: "y", text: "B" }], pairs: [{ leftId: "1", rightId: "x" }, { leftId: "2", rightId: "y" }] });
    expect(gradeResponse(m, { pairs: [{ leftId: "1", rightId: "x" }, { leftId: "2", rightId: "x" }] })).toEqual({ outcome: "partial", fraction: 0.5 });

    const o = parse("ordering", { prompt: "O", items: [{ id: "1", text: "a" }, { id: "2", text: "b" }, { id: "3", text: "c" }, { id: "4", text: "d" }], correctOrder: ["1", "2", "3", "4"], partialCredit: true });
    expect(gradeResponse(o, { order: ["1", "2", "4", "3"] })).toEqual({ outcome: "partial", fraction: 0.5 });

    const f = parse("fill_blank", { prompt: "[[a]] [[b]]", blanks: [{ id: "a", acceptedAnswers: ["x"] }, { id: "b", acceptedAnswers: ["y"] }] });
    expect(gradeResponse(f, { blanks: { a: "X", b: "z" } })).toEqual({ outcome: "partial", fraction: 0.5 });

    const d = parse("drag_drop", { prompt: "D", targets: [{ id: "t", text: "T" }], draggables: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "x", text: "X" }], placements: [{ draggableId: "a", targetId: "t" }, { draggableId: "b", targetId: "t" }] });
    expect(gradeResponse(d, { placements: [{ draggableId: "a", targetId: "t" }, { draggableId: "b", targetId: "t" }] }).outcome).toBe("correct");
    expect(gradeResponse(d, { placements: [{ draggableId: "a", targetId: "t" }, { draggableId: "b", targetId: "t" }, { draggableId: "x", targetId: "t" }] })).toEqual({ outcome: "partial", fraction: 0.5 });
  });

  it("pronunciation and custom wait for AI or a person", () => {
    const p = parse("pronunciation", { prompt: "Read", targetText: "你好", speechLanguage: "cmn" });
    expect(gradeResponse(p, { recordingId: "r1" })).toEqual({ outcome: "pending_ai", fraction: null });
    expect(toGradedItem({ itemId: "p", points: 1, difficulty: "easy" }, gradeResponse(p, { recordingId: "r1" }))).toBeNull();
    const c = parse("custom", { prompt: "C", customType: "x" });
    expect(gradeResponse(c, { custom: {} }).outcome).toBe("pending_manual");
  });

  it("feeds the scoring engine", () => {
    const item = parse("single_choice", single, { points: 3, difficulty: "hard" });
    expect(toGradedItem({ ...item, itemId: "q1" }, gradeResponse(item, { optionId: "b" }), 1200)).toEqual({
      itemId: "q1", maxPoints: 3, difficulty: "hard", outcome: "correct", timeMs: 1200,
    });
  });
});

describe("translations", () => {
  const item = parse("single_choice", single, { explanation: "Two plus two is four." });

  it("exposes only display strings, never answers", () => {
    expect(translatableStrings(item)).toEqual({ prompt: "2 + 2 = ?", "options.a.text": "3", "options.b.text": "4", explanation: "Two plus two is four." });
    const p = parse("pronunciation", { prompt: "Read aloud", targetText: "你好", speechLanguage: "cmn" });
    expect(Object.keys(translatableStrings(p))).toEqual(["prompt"]);
  });

  it("detects unknown and missing paths", () => {
    expect(checkTranslation(item, { prompt: "2 + 2 = ?", "options.z.text": "x" })).toEqual({
      unknownPaths: ["options.z.text"],
      missingPaths: ["explanation", "options.a.text", "options.b.text"],
    });
  });

  it("localizes with fallback to the base text", () => {
    const th = localizeItem(item, { prompt: "2 + 2 เท่ากับเท่าไร", explanation: "สองบวกสองเท่ากับสี่" });
    expect((th.body as { prompt: string }).prompt).toBe("2 + 2 เท่ากับเท่าไร");
    expect((th.body as { options: { text: string }[] }).options[0]!.text).toBe("3");
    expect((item.body as { prompt: string }).prompt).toBe("2 + 2 = ?");
  });

  it("source hash changes when text changes, not when key order does", () => {
    const a = translatableStrings(item);
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(sourceHash(reordered)).toBe(sourceHash(a));
    expect(sourceHash({ ...a, prompt: "2+2?" })).not.toBe(sourceHash(a));
  });
});

describe("content pools for competitions", () => {
  const summary = (contentType: "single_choice" | "text_input", difficulty: "easy" | "hard", locales = ["en"]) => ({ contentType, difficulty, category: "maths", tags: ["p4"], locales });

  it("filters by format, difficulty, category and tag", () => {
    const items = [summary("single_choice", "easy"), summary("single_choice", "hard"), summary("text_input", "easy")];
    expect(matchingItems(items, ["single_choice"]).length).toBe(2);
    expect(matchingItems(items, ["single_choice", "text_input"], { difficulties: ["easy"] }).length).toBe(2);
    expect(matchingItems(items, ["single_choice"], { tags: ["P4"] }).length).toBe(2);
    expect(matchingItems(items, ["single_choice"], { categories: ["science"] }).length).toBe(0);
  });

  it("reports missing versions, small pools and missing translations", () => {
    const config = standardTemplate();
    const vid = crypto.randomUUID();
    config.rounds[0]!.groups[0]!.content.contentBankVersionId = vid;
    config.rounds[0]!.groups[1]!.content.contentBankVersionId = crypto.randomUUID();
    const versions = new Map([[vid, Array.from({ length: 25 }, (_, i) => summary("single_choice", "easy", i < 5 ? ["en", "th"] : ["en"]))]]);
    const found = validateContentReferences(config, versions, ["en", "th"]);
    const codes = found.map((i) => `${i.severity}:${i.code}:${i.path}`);
    expect(codes).toContain("warning:TRANSLATIONS_MISSING:rounds.0.groups.0.content");
    expect(codes).toContain("error:UNKNOWN_CONTENT_VERSION:rounds.0.groups.1.content.contentBankVersionId");
    expect(codes).toContain("warning:NO_CONTENT:rounds.0.groups.2.content");
    config.rounds[0]!.groups[0]!.questionCount = 30;
    expect(validateContentReferences(config, versions, ["en"]).map((i) => i.code)).toContain("CONTENT_POOL_TOO_SMALL");
  });
});
