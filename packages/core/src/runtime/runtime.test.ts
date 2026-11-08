import { describe, expect, it } from "vitest";
import { RoundGroupSchema } from "../competition/config.ts";
import { parseContentItem, type ContentItemData } from "../content/items.ts";
import {
  NETWORK_GRACE_MS,
  OFFLINE_SYNC_GRACE_MS,
  attemptDeadline,
  buildQuestionSet,
  decideAnswerSave,
  detectAnswerPattern,
  detectAnswerSimilarity,
  detectImpossibleSpeed,
  participantView,
  remainingSeconds,
  riskScore,
  rng,
  seedFrom,
  shuffle,
  type PoolItem,
} from "./index.ts";

const item = (key: string, type = "single_choice", body?: unknown): PoolItem => {
  const r = parseContentItem({
    externalKey: key, contentType: type, baseLocale: "en", difficulty: "easy",
    body: body ?? { prompt: `Q ${key}`, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }], correctOptionId: "b" },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return { itemId: `id-${key}`, externalKey: key, contentType: r.item.contentType, difficulty: r.item.difficulty, category: null, tags: [], locales: ["en"], item: r.item };
};
const pool = Array.from({ length: 30 }, (_, i) => item(`Q-${String(i).padStart(2, "0")}`));
const rg = (extra: Record<string, unknown> = {}) => RoundGroupSchema.parse({ groupId: crypto.randomUUID(), questionCount: 10, ...extra });

describe("seeded randomness", () => {
  it("is reproducible and seed-dependent", () => {
    const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], rng(seedFrom("attempt-1")));
    expect(shuffle([1, 2, 3, 4, 5, 6, 7, 8], rng(seedFrom("attempt-1")))).toEqual(a);
    expect(shuffle([1, 2, 3, 4, 5, 6, 7, 8], rng(seedFrom("attempt-2")))).not.toEqual(a);
  });
});

describe("question sets", () => {
  it("fixed selection gives everyone the same questions, in a per-attempt order", () => {
    const a = buildQuestionSet(pool, rg(), "a1");
    const b = buildQuestionSet(pool, rg(), "a2");
    expect(new Set(a.map((q) => q.itemId))).toEqual(new Set(b.map((q) => q.itemId)));
    expect(new Set(a.map((q) => q.itemId))).toEqual(new Set(pool.slice(0, 10).map((p) => p.itemId)));
    expect(a.map((q) => q.itemId)).not.toEqual(b.map((q) => q.itemId));
    expect(buildQuestionSet(pool, rg(), "a1")).toEqual(a);
  });

  it("random pools draw different questions; order is kept when not randomized", () => {
    const a = buildQuestionSet(pool, rg({ content: { selection: "random_from_pool" } }), "a1");
    const b = buildQuestionSet(pool, rg({ content: { selection: "random_from_pool" } }), "a2");
    expect(a).toHaveLength(10);
    expect(new Set(a.map((q) => q.itemId))).not.toEqual(new Set(b.map((q) => q.itemId)));
    const fixedOrder = buildQuestionSet(pool, rg({ randomizeQuestions: false, randomizeOptions: false }), "a1");
    expect(fixedOrder.map((q) => q.itemId)).toEqual(pool.slice(0, 10).map((p) => p.itemId));
    expect(fixedOrder[0]!.order.options).toEqual(["a", "b", "c", "d"]);
  });

  it("always shuffles parts whose stored order is the answer", () => {
    const ordering = item("ORD", "ordering", { prompt: "Order", items: ["1", "2", "3", "4", "5"].map((id) => ({ id, text: id })), correctOrder: ["1", "2", "3", "4", "5"] });
    const [q] = buildQuestionSet([ordering], rg({ questionFormats: ["ordering"], questionCount: 1, randomizeOptions: false }), "x");
    expect(q!.order.items).not.toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("participant view", () => {
  it("removes answers and applies the attempt's order and translation", () => {
    const p = pool[0]!;
    const view = participantView(p.item, { itemId: p.itemId, order: { options: ["d", "c", "b", "a"] } }, { prompt: "Translated", "options.a.text": "Ａ" }) as Record<string, unknown>;
    expect(view.prompt).toBe("Translated");
    expect((view.options as { id: string }[]).map((o) => o.id)).toEqual(["d", "c", "b", "a"]);
    expect(JSON.stringify(view)).not.toContain("correctOptionId");

    const tf = item("TF", "true_false", { prompt: "Sky is blue", answer: true });
    expect(JSON.stringify(participantView(tf.item, { itemId: tf.itemId, order: {} }, null))).not.toContain("answer");
    const text = item("TX", "text_input", { prompt: "Capital?", acceptedAnswers: ["Paris"] });
    expect(JSON.stringify(participantView(text.item, { itemId: text.itemId, order: {} }, null))).not.toContain("Paris");
    const fill = item("FB", "fill_blank", { prompt: "I [[a]] here", blanks: [{ id: "a", acceptedAnswers: ["am"] }] });
    expect(participantView(fill.item, { itemId: fill.itemId, order: {} }, null)).toMatchObject({ blanks: [{ id: "a" }] });
    expect(JSON.stringify(participantView(fill.item, { itemId: fill.itemId, order: {} }, null))).not.toContain("acceptedAnswers");
    const match = item("MT", "matching", { prompt: "M", left: [{ id: "1", text: "x" }, { id: "2", text: "y" }], right: [{ id: "a", text: "X" }, { id: "b", text: "Y" }], pairs: [{ leftId: "1", rightId: "a" }, { leftId: "2", rightId: "b" }] });
    expect(JSON.stringify(participantView(match.item, { itemId: match.itemId, order: { right: ["b", "a"] } }, null))).not.toContain("pairs");
  });
});

describe("timing", () => {
  const start = new Date("2026-12-01T10:00:00Z");
  const closes = new Date("2026-12-01T10:20:00Z");
  it("caps the deadline at the round close and includes extensions", () => {
    expect(attemptDeadline(start, 600, 0, closes).toISOString()).toBe("2026-12-01T10:10:00.000Z");
    expect(attemptDeadline(start, 600, 300, closes).toISOString()).toBe("2026-12-01T10:15:00.000Z");
    expect(attemptDeadline(start, 1800, 0, closes)).toEqual(closes);
    expect(remainingSeconds(new Date("2026-12-01T10:10:00Z"), new Date("2026-12-01T10:09:59.2Z"))).toBe(1);
  });

  it("accepts in-time and network-grace saves, offline saves made before the deadline (flagged), and nothing else", () => {
    const deadline = new Date("2026-12-01T10:10:00Z");
    const at = (ms: number) => new Date(deadline.getTime() + ms);
    expect(decideAnswerSave({ now: at(-1000), deadline, startedAt: start, clientSavedAt: at(-1000) })).toEqual({ accept: true, late: false });
    expect(decideAnswerSave({ now: at(NETWORK_GRACE_MS - 1), deadline, startedAt: start, clientSavedAt: null })).toEqual({ accept: true, late: false });
    expect(decideAnswerSave({ now: at(60_000), deadline, startedAt: start, clientSavedAt: at(-5000) })).toEqual({ accept: true, late: true });
    expect(decideAnswerSave({ now: at(60_000), deadline, startedAt: start, clientSavedAt: at(1000) })).toEqual({ accept: false, reason: "after_deadline" });
    expect(decideAnswerSave({ now: at(OFFLINE_SYNC_GRACE_MS + 1), deadline, startedAt: start, clientSavedAt: at(-5000) })).toEqual({ accept: false, reason: "after_deadline" });
    expect(decideAnswerSave({ now: at(-60_000), deadline, startedAt: start, clientSavedAt: at(0) })).toEqual({ accept: false, reason: "client_time_invalid" });
  });
});

describe("integrity", () => {
  it("scores signals with caps, and ignores copy/paste when allowed", () => {
    const events = [...Array(10).fill({ type: "tab_hidden" }), { type: "paste" }, { type: "paste" }, { type: "unknown_thing" }];
    expect(riskScore(events, { copyPaste: "flag" })).toEqual({ score: 31, signals: [{ type: "paste", count: 2, points: 16 }, { type: "tab_hidden", count: 10, points: 15 }] });
    expect(riskScore(events, { copyPaste: "allow" }).score).toBe(15);
    expect(riskScore(Array(20).fill({ type: "concurrent_session" }), { copyPaste: "flag" }).score).toBe(30);
  });

  const fact = (i: number, o: Partial<{ correct: boolean; timeSpentMs: number; response: string; displayedPosition: number | null }> = {}) => ({
    itemId: `q${i}`, response: `"r${i}"`, correct: true, timeSpentMs: 20_000, displayedPosition: i % 4, ...o,
  });

  it("detects impossible speed", () => {
    expect(detectImpossibleSpeed(Array.from({ length: 10 }, (_, i) => fact(i, { timeSpentMs: i < 4 ? 600 : 20_000 })))).toEqual({ fast: 4, total: 10 });
    expect(detectImpossibleSpeed(Array.from({ length: 10 }, (_, i) => fact(i, { timeSpentMs: i < 2 ? 600 : 20_000 })))).toBeNull();
  });

  it("detects one-position answering", () => {
    expect(detectAnswerPattern(Array.from({ length: 10 }, (_, i) => fact(i, { displayedPosition: 0 })))).toEqual({ position: 0, share: 1 });
    expect(detectAnswerPattern(Array.from({ length: 10 }, (_, i) => fact(i)))).toBeNull();
  });

  it("detects shared wrong answers, not shared right ones", () => {
    const mine = Array.from({ length: 10 }, (_, i) => fact(i, { correct: i >= 6, response: `"w${i}"` }));
    const twin = Array.from({ length: 10 }, (_, i) => fact(i, { correct: i >= 6, response: `"w${i}"` }));
    expect(detectAnswerSimilarity(mine, twin)).toEqual({ sharedWrong: 6, myWrong: 6 });
    const differentWrong = twin.map((a) => (a.correct ? a : { ...a, response: `"other"` }));
    expect(detectAnswerSimilarity(mine, differentWrong)).toBeNull();
    const allRight = Array.from({ length: 10 }, (_, i) => fact(i));
    expect(detectAnswerSimilarity(allRight, allRight)).toBeNull();
  });
});
