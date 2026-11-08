import { z } from "zod";
import { LOCALES } from "../locales.ts";
import { QUESTION_TYPES, type QuestionType } from "../competition/config.ts";
import { DIFFICULTIES } from "../competition/scoring.ts";

/**
 * Content items (questions). An item has stable metadata (type, difficulty,
 * points, category, tags, skills, objectives, media, source) and a
 * type-specific `body` in its base locale. Translations are stored apart from
 * the item and overlay only the translatable strings (see translation.ts).
 *
 * Answers live in the body and are never sent to participants by the runtime.
 */

const text = z.string().trim().min(1).max(5000);
const shortText = z.string().trim().min(1).max(1000);
const optId = z.string().regex(/^[a-z0-9_-]{1,20}$/, "1-20 lowercase letters, digits, - or _");

export const MEDIA_KINDS = ["image", "audio", "video"] as const;
export const MediaRefSchema = z.object({
  kind: z.enum(MEDIA_KINDS),
  url: z.url({ protocol: /^https$/ }).max(2000),
  mimeType: z.string().max(100).optional(),
  altText: z.string().max(500).optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

const Option = z.object({ id: optId, text: shortText.optional(), media: MediaRefSchema.optional() }).refine(
  (o) => o.text !== undefined || o.media !== undefined,
  "an option needs text or media",
);
const Labeled = z.object({ id: optId, text: shortText });

const uniqueIds = (list: { id: string }[]) => new Set(list.map((x) => x.id)).size === list.length;
const prompt = { prompt: text, promptMedia: z.array(MediaRefSchema).max(5).default([]) };

const SingleChoiceBody = z
  .object({ ...prompt, options: z.array(Option).min(2).max(10), correctOptionId: optId })
  .refine((b) => uniqueIds(b.options), "option ids must be unique")
  .refine((b) => b.options.some((o) => o.id === b.correctOptionId), "correctOptionId must be one of the options");

const MultipleChoiceBody = z
  .object({
    ...prompt,
    options: z.array(Option).min(2).max(10),
    correctOptionIds: z.array(optId).min(1),
    /** Partial: (right picks − wrong picks) / correct options, never below 0. */
    partialCredit: z.boolean().default(false),
  })
  .refine((b) => uniqueIds(b.options), "option ids must be unique")
  .refine((b) => b.correctOptionIds.every((id) => b.options.some((o) => o.id === id)), "every correct id must be an option")
  .refine((b) => new Set(b.correctOptionIds).size === b.correctOptionIds.length, "correct ids must be unique");

const TrueFalseBody = z.object({ ...prompt, answer: z.boolean() });

const MatchingBody = z
  .object({
    ...prompt,
    left: z.array(Labeled).min(2).max(12),
    right: z.array(Labeled).min(2).max(12),
    pairs: z.array(z.object({ leftId: optId, rightId: optId })).min(1),
  })
  .refine((b) => uniqueIds(b.left) && uniqueIds(b.right), "ids must be unique")
  .refine(
    (b) => b.pairs.every((p) => b.left.some((l) => l.id === p.leftId) && b.right.some((r) => r.id === p.rightId)),
    "pairs must refer to existing left and right ids",
  )
  .refine((b) => new Set(b.pairs.map((p) => p.leftId)).size === b.pairs.length, "each left item may be paired once");

const OrderingBody = z
  .object({ ...prompt, items: z.array(Labeled).min(2).max(15), correctOrder: z.array(optId), partialCredit: z.boolean().default(false) })
  .refine((b) => uniqueIds(b.items), "item ids must be unique")
  .refine(
    (b) => b.correctOrder.length === b.items.length && b.items.every((i) => b.correctOrder.includes(i.id)),
    "correctOrder must list every item exactly once",
  );

const ImageChoiceBody = SingleChoiceBody.refine((b) => b.options.every((o) => o.media?.kind === "image"), "every option needs an image");
const AudioChoiceBody = SingleChoiceBody.refine((b) => b.options.every((o) => o.media?.kind === "audio"), "every option needs an audio clip");
const ListenSelectBody = SingleChoiceBody.refine((b) => b.promptMedia.some((m) => m.kind === "audio"), "the prompt needs an audio clip");

const TextMatch = {
  caseSensitive: z.boolean().default(false),
  /** Ignore spaces entirely (useful for CJK answers). */
  ignoreSpaces: z.boolean().default(false),
};
const TextInputBody = z.object({ ...prompt, acceptedAnswers: z.array(shortText).min(1).max(50), ...TextMatch });

const FillBlankBody = z
  .object({
    /** Blanks are marked in the prompt as [[blankId]]. */
    ...prompt,
    blanks: z.array(z.object({ id: optId, acceptedAnswers: z.array(shortText).min(1).max(50) })).min(1).max(20),
    ...TextMatch,
    partialCredit: z.boolean().default(true),
  })
  .refine((b) => uniqueIds(b.blanks), "blank ids must be unique")
  .refine((b) => b.blanks.every((bl) => b.prompt.includes(`[[${bl.id}]]`)), "every blank must appear in the prompt as [[id]]");

export const SPEECH_LANGUAGES = ["cmn", "yue", "en", "th"] as const;
export const PRONUNCIATION_ASPECTS = ["initials", "finals", "vowels", "tones", "tone_combinations", "syllables", "fluency", "rhythm", "intelligibility", "phonemes"] as const;
const PronunciationBody = z.object({
  ...prompt,
  /** The text the student reads aloud, in the speech language (not translated). */
  targetText: text,
  /** Speech language: Mandarin (cmn), Cantonese (yue), English, Thai. */
  speechLanguage: z.enum(SPEECH_LANGUAGES),
  romanization: z.string().max(5000).optional(),
  referenceAudio: MediaRefSchema.refine((m) => m.kind === "audio", "reference must be audio").optional(),
  aspects: z.array(z.enum(PRONUNCIATION_ASPECTS)).min(1).default(["syllables", "tones", "fluency"]),
  maxRecordingSeconds: z.number().int().min(3).max(300).default(30),
});

const DragDropBody = z
  .object({
    ...prompt,
    targets: z.array(Labeled).min(1).max(12),
    draggables: z.array(Labeled).min(1).max(20),
    /** Draggables not listed here are distractors. */
    placements: z.array(z.object({ draggableId: optId, targetId: optId })).min(1),
    partialCredit: z.boolean().default(true),
  })
  .refine((b) => uniqueIds(b.targets) && uniqueIds(b.draggables), "ids must be unique")
  .refine(
    (b) => b.placements.every((p) => b.draggables.some((d) => d.id === p.draggableId) && b.targets.some((t) => t.id === p.targetId)),
    "placements must refer to existing draggables and targets",
  )
  .refine((b) => new Set(b.placements.map((p) => p.draggableId)).size === b.placements.length, "each draggable has one place");

const CustomBody = z.object({
  ...prompt,
  /** Key of a custom renderer registered by the tenant's front end. */
  customType: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  data: z.record(z.string(), z.unknown()).default({}),
  /** Custom items are graded by a person in the judge workspace. */
  grading: z.literal("manual").default("manual"),
});

export const ITEM_BODY_SCHEMAS = {
  single_choice: SingleChoiceBody,
  multiple_choice: MultipleChoiceBody,
  true_false: TrueFalseBody,
  matching: MatchingBody,
  ordering: OrderingBody,
  image_choice: ImageChoiceBody,
  audio_choice: AudioChoiceBody,
  listen_select: ListenSelectBody,
  text_input: TextInputBody,
  fill_blank: FillBlankBody,
  pronunciation: PronunciationBody,
  drag_drop: DragDropBody,
  custom: CustomBody,
} satisfies Record<QuestionType, z.ZodType>;

export type ItemBody<T extends QuestionType = QuestionType> = z.output<(typeof ITEM_BODY_SCHEMAS)[T]>;

export const ContentItemSchema = z.object({
  /** Stable, human-facing id used in Excel (e.g. "MAND-P4-0012"). */
  externalKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, . _ - (max 64)"),
  contentType: z.enum(QUESTION_TYPES),
  baseLocale: z.enum(LOCALES),
  difficulty: z.enum(DIFFICULTIES),
  points: z.number().gt(0).max(1000).default(1),
  category: z.string().trim().max(100).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  explanation: z.string().trim().max(5000).nullable().default(null),
  explanationMedia: z.array(MediaRefSchema).max(5).default([]),
  sourceReference: z.string().trim().max(1000).nullable().default(null),
  skillIds: z.array(z.uuid()).max(20).default([]),
  objectiveIds: z.array(z.uuid()).max(20).default([]),
  body: z.unknown(),
});
export type ContentItemInput = z.input<typeof ContentItemSchema>;
export type ContentItemData = Omit<z.output<typeof ContentItemSchema>, "body"> & { body: ItemBody };

export interface ItemIssue {
  path: string;
  message: string;
}

/** Validate an item, including its type-specific body. */
export function parseContentItem(input: unknown): { ok: true; item: ContentItemData } | { ok: false; issues: ItemIssue[] } {
  const base = ContentItemSchema.safeParse(input);
  // Check the body whenever the type is known, so one pass reports every problem (useful for Excel error reports).
  const type = (input as { contentType?: unknown } | null)?.contentType;
  const schema = typeof type === "string" && type in ITEM_BODY_SCHEMAS ? (ITEM_BODY_SCHEMAS[type as QuestionType] as z.ZodType<ItemBody>) : null;
  const body = schema?.safeParse((input as { body?: unknown }).body);
  const issues: ItemIssue[] = [
    ...(base.success ? [] : base.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))),
    ...(body && !body.success ? body.error.issues.map((i) => ({ path: ["body", ...i.path].join("."), message: i.message })) : []),
  ];
  if (!base.success || !body || !body.success) return { ok: false, issues };
  const tags = [...new Set(base.data.tags.map((t) => t.toLowerCase()))];
  return {
    ok: true,
    item: {
      ...base.data,
      tags,
      skillIds: [...new Set(base.data.skillIds)],
      objectiveIds: [...new Set(base.data.objectiveIds)],
      body: body.data,
    },
  };
}

/** Every media reference in an item, for upload checks and retention. */
export function itemMedia(item: ContentItemData): MediaRef[] {
  const b = item.body as Record<string, unknown>;
  const out: MediaRef[] = [...item.explanationMedia, ...((b.promptMedia as MediaRef[]) ?? [])];
  for (const o of (b.options as { media?: MediaRef }[] | undefined) ?? []) if (o.media) out.push(o.media);
  const ref = (b as { referenceAudio?: MediaRef }).referenceAudio;
  if (ref) out.push(ref);
  return out;
}
