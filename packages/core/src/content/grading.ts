import type { GradedItem } from "../competition/scoring.ts";
import type { ContentItemData, ItemBody } from "./items.ts";

/**
 * Deterministic answer checking for each question type. Returns the outcome
 * and a 0..1 fraction; the round's scoring rule (stage 2) turns that into
 * points. Pronunciation goes to the AI queue (AI_PENDING, stage 7) and custom
 * items go to manual grading. Neither blocks the participant.
 */
export type GradeOutcome =
  | { outcome: "correct" | "incorrect" | "partial" | "unanswered"; fraction: number }
  | { outcome: "pending_ai" | "pending_manual"; fraction: null };

export type Response =
  | { optionId: string }
  | { optionIds: string[] }
  | { value: boolean }
  | { pairs: Array<{ leftId: string; rightId: string }> }
  | { order: string[] }
  | { text: string }
  | { blanks: Record<string, string> }
  | { placements: Array<{ draggableId: string; targetId: string }> }
  | { recordingId: string }
  | { custom: unknown };

/** NFKC folds full-width forms (Ａ→A, ２→2); whitespace collapses; case folds unless case-sensitive. */
export function normalizeAnswer(s: string, opts: { caseSensitive: boolean; ignoreSpaces: boolean }): string {
  let out = s.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (opts.ignoreSpaces) out = out.replace(/ /g, "");
  if (!opts.caseSensitive) out = out.toLocaleLowerCase();
  // Treat common CJK and Latin punctuation at the end as insignificant.
  return out.replace(/[.。!！?？,，、]+$/u, "");
}

const done = (fraction: number): GradeOutcome => {
  const f = Math.round(Math.min(1, Math.max(0, fraction)) * 1e6) / 1e6;
  return { outcome: f >= 1 ? "correct" : f <= 0 ? "incorrect" : "partial", fraction: f };
};
const UNANSWERED: GradeOutcome = { outcome: "unanswered", fraction: 0 };

export function gradeResponse(item: Pick<ContentItemData, "contentType" | "body">, response: Response | null | undefined): GradeOutcome {
  if (item.contentType === "pronunciation") return { outcome: "pending_ai", fraction: null };
  if (item.contentType === "custom") return { outcome: "pending_manual", fraction: null };
  if (!response) return UNANSWERED;
  const r = response as Record<string, unknown>;

  switch (item.contentType) {
    case "single_choice":
    case "image_choice":
    case "audio_choice":
    case "listen_select": {
      const b = item.body as ItemBody<"single_choice">;
      if (typeof r.optionId !== "string") return UNANSWERED;
      return done(r.optionId === b.correctOptionId ? 1 : 0);
    }
    case "multiple_choice": {
      const b = item.body as ItemBody<"multiple_choice">;
      const picked = new Set(Array.isArray(r.optionIds) ? (r.optionIds as string[]) : []);
      if (picked.size === 0) return UNANSWERED;
      const correct = new Set(b.correctOptionIds);
      const right = [...picked].filter((id) => correct.has(id)).length;
      const wrong = picked.size - right;
      if (right === correct.size && wrong === 0) return done(1);
      return done(b.partialCredit ? (right - wrong) / correct.size : 0);
    }
    case "true_false": {
      const b = item.body as ItemBody<"true_false">;
      if (typeof r.value !== "boolean") return UNANSWERED;
      return done(r.value === b.answer ? 1 : 0);
    }
    case "matching": {
      const b = item.body as ItemBody<"matching">;
      const given = new Map(((r.pairs as Array<{ leftId: string; rightId: string }>) ?? []).map((p) => [p.leftId, p.rightId]));
      if (given.size === 0) return UNANSWERED;
      const ok = b.pairs.filter((p) => given.get(p.leftId) === p.rightId).length;
      return done(ok / b.pairs.length);
    }
    case "ordering": {
      const b = item.body as ItemBody<"ordering">;
      const order = Array.isArray(r.order) ? (r.order as string[]) : [];
      if (order.length === 0) return UNANSWERED;
      const ok = b.correctOrder.filter((id, i) => order[i] === id).length;
      if (ok === b.correctOrder.length && order.length === ok) return done(1);
      return done(b.partialCredit ? ok / b.correctOrder.length : 0);
    }
    case "text_input": {
      const b = item.body as ItemBody<"text_input">;
      if (typeof r.text !== "string" || !r.text.trim()) return UNANSWERED;
      const given = normalizeAnswer(r.text, b);
      return done(b.acceptedAnswers.some((a) => normalizeAnswer(a, b) === given) ? 1 : 0);
    }
    case "fill_blank": {
      const b = item.body as ItemBody<"fill_blank">;
      const blanks = (r.blanks ?? {}) as Record<string, string>;
      const answered = b.blanks.filter((bl) => typeof blanks[bl.id] === "string" && blanks[bl.id]!.trim());
      if (answered.length === 0) return UNANSWERED;
      const ok = b.blanks.filter((bl) => {
        const v = blanks[bl.id];
        return typeof v === "string" && bl.acceptedAnswers.some((a) => normalizeAnswer(a, b) === normalizeAnswer(v, b));
      }).length;
      if (ok === b.blanks.length) return done(1);
      return done(b.partialCredit ? ok / b.blanks.length : 0);
    }
    case "drag_drop": {
      const b = item.body as ItemBody<"drag_drop">;
      const given = new Map(((r.placements as Array<{ draggableId: string; targetId: string }>) ?? []).map((p) => [p.draggableId, p.targetId]));
      if (given.size === 0) return UNANSWERED;
      const ok = b.placements.filter((p) => given.get(p.draggableId) === p.targetId).length;
      // Placing a distractor counts against the answer.
      const placedDistractors = [...given.keys()].filter((id) => !b.placements.some((p) => p.draggableId === id)).length;
      const fraction = (ok - placedDistractors) / b.placements.length;
      if (ok === b.placements.length && placedDistractors === 0) return done(1);
      return done(b.partialCredit ? fraction : 0);
    }
  }
}

/** Combine an item and its grade into the scoring engine's input. Pending grades return null. */
export function toGradedItem(
  item: Pick<ContentItemData, "difficulty" | "points"> & { itemId: string },
  grade: GradeOutcome,
  timeMs?: number,
): GradedItem | null {
  if (grade.fraction === null) return null;
  return {
    itemId: item.itemId,
    maxPoints: item.points,
    difficulty: item.difficulty,
    outcome: grade.outcome as GradedItem["outcome"],
    ...(grade.outcome === "partial" && { fraction: grade.fraction }),
    ...(timeMs !== undefined && { timeMs }),
  };
}
