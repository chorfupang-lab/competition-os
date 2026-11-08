import { z } from "zod";
import { LOCALES } from "../locales.ts";
import type { EligibilityRule } from "./eligibility.ts";
import { DIFFICULTIES } from "./scoring.ts";
import { RANKING_SCOPES, TIE_BREAKERS } from "./ranking.ts";

/**
 * Competition configuration: the versioned document behind
 * Competition → Round → Group.
 *
 * - `groups` are defined once (with eligibility) and toggled per round.
 * - Each round has a `groups` list with the per-round-group settings:
 *   timing, question formats, content source, UI, scoring, ranking,
 *   qualification and integrity. So every round × group can differ.
 * - IDs are UUIDs chosen by the client and stable across versions;
 *   registrations, attempts and results refer to them.
 */

export const QUESTION_TYPES = [
  "single_choice",
  "multiple_choice",
  "true_false",
  "matching",
  "ordering",
  "image_choice",
  "audio_choice",
  "listen_select",
  "text_input",
  "fill_blank",
  "pronunciation",
  "drag_drop",
  "custom",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const ROUND_KINDS = ["qualifying", "final", "practice", "other"] as const;

const zKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lowercase letters, digits, - or _ (max 40)");
const zI18nText = z
  .partialRecord(z.enum(LOCALES), z.string().trim().min(1).max(500))
  .refine((o) => Object.keys(o).length > 0, "at least one language is required");
const zDate = z.iso.date();
const zDateTime = z.iso.datetime({ offset: true });

export const EligibilityRuleSchema: z.ZodType<EligibilityRule> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("open") }),
    z.object({ type: z.literal("all"), rules: z.array(EligibilityRuleSchema).min(1).max(20) }),
    z.object({ type: z.literal("any"), rules: z.array(EligibilityRuleSchema).min(1).max(20) }),
    z.object({
      type: z.literal("age"),
      min: z.number().int().min(0).max(120).optional(),
      max: z.number().int().min(0).max(120).optional(),
      asOf: zDate,
    }),
    z.object({ type: z.literal("birth_date"), from: zDate.optional(), to: zDate.optional() }),
    z.object({ type: z.literal("grade_level"), min: z.number().int().min(-3).max(13).optional(), max: z.number().int().min(-3).max(13).optional() }),
    z.object({ type: z.literal("grade"), in: z.array(z.string().trim().min(1).max(40)).min(1).max(50) }),
  ]),
);

export const ScoringRuleSchema = z.object({
  correctPoints: z.union([z.literal("item"), z.number().min(0).max(1000)]).default("item"),
  incorrectPoints: z.number().min(-1000).max(0).default(0),
  unansweredPoints: z.number().min(-1000).max(1000).default(0),
  partialCredit: z.enum(["none", "proportional"]).default("none"),
  difficultyMultipliers: z
    .object(Object.fromEntries(DIFFICULTIES.map((d) => [d, z.number().min(0).max(100).default(1)])) as Record<
      (typeof DIFFICULTIES)[number],
      z.ZodDefault<z.ZodNumber>
    >)
    .default({ easy: 1, medium: 1, hard: 1, expert: 1 }),
  floorAtZero: z.boolean().default(true),
});

export const RankingRuleSchema = z.object({
  tieBreakers: z.array(z.enum(TIE_BREAKERS)).min(1).default(["total_score", "accuracy", "time", "hard_question_score", "earlier_submission"]),
  /** Which ranking tables to produce besides the group ranking. */
  scopes: z.array(z.enum(RANKING_SCOPES)).default(["group"]),
});

export const QualificationCriterionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("top_n"), n: z.number().int().min(1).max(1_000_000) }),
  z.object({ type: z.literal("top_percent"), percent: z.number().gt(0).max(100) }),
  z.object({ type: z.literal("score_at_least"), score: z.number() }),
  z.object({ type: z.literal("rank_at_most"), rank: z.number().int().min(1) }),
]);

export const QualificationRuleSchema = z.object({
  combine: z.enum(["any", "all"]).default("any"),
  criteria: z.array(QualificationCriterionSchema).max(10),
  ties: z.enum(["include", "exclude"]).default("include"),
  quota: z
    .object({ scope: z.enum(["school", "country", "region", "class", "team"]), max: z.number().int().min(1) })
    .nullable()
    .default(null),
  maxWildcards: z.number().int().min(0).default(0),
});

export const RoundGroupSchema = z.object({
  groupId: z.uuid(),
  enabled: z.boolean().default(true),
  durationSeconds: z.number().int().min(30).max(86_400).default(1800),
  questionCount: z.number().int().min(1).max(500).nullable().default(null),
  questionFormats: z.array(z.enum(QUESTION_TYPES)).min(1).default(["single_choice"]),
  /** Filled in by the content engine (stage 3): a Content Bank Version, never copied questions. */
  content: z
    .object({
      contentBankVersionId: z.uuid().nullable().default(null),
      /** fixed: every participant gets the same questions; random_from_pool: drawn per participant. */
      selection: z.enum(["fixed", "random_from_pool"]).default("fixed"),
      filters: z
        .object({
          difficulties: z.array(z.enum(DIFFICULTIES)).optional(),
          categories: z.array(z.string().max(100)).optional(),
          tags: z.array(z.string().max(50)).optional(),
        })
        .default({}),
    })
    .default({ contentBankVersionId: null, selection: "fixed", filters: {} }),
  randomizeQuestions: z.boolean().default(true),
  randomizeOptions: z.boolean().default(true),
  ui: z
    .object({
      theme: zKey.default("default"),
      layout: z.enum(["one_per_page", "scroll"]).default("one_per_page"),
      showTimer: z.boolean().default(true),
      showProgress: z.boolean().default(true),
      showScoreOnSubmit: z.boolean().default(false),
    })
    .default({ theme: "default", layout: "one_per_page", showTimer: true, showProgress: true, showScoreOnSubmit: false }),
  scoring: ScoringRuleSchema.default(() => ScoringRuleSchema.parse({})),
  ranking: RankingRuleSchema.default(() => RankingRuleSchema.parse({})),
  qualification: QualificationRuleSchema.nullable().default(null),
  /** Used by the runtime (stage 5). Risk signals are for review, never automatic penalties. */
  integrity: z
    .object({
      fullscreen: z.enum(["off", "warn", "pause", "auto_submit"]).default("warn"),
      copyPaste: z.enum(["allow", "block", "flag"]).default("flag"),
      maxDevices: z.number().int().min(1).max(10).nullable().default(1),
    })
    .default({ fullscreen: "warn", copyPaste: "flag", maxDevices: 1 }),
});

export const RoundSchema = z.object({
  id: z.uuid(),
  key: zKey,
  name: zI18nText,
  kind: z.enum(ROUND_KINDS),
  opensAt: zDateTime,
  closesAt: zDateTime,
  entry: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("registration") }),
      z.object({ type: z.literal("qualified_from"), roundId: z.uuid() }),
    ])
    .default({ type: "registration" }),
  attemptPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(100).nullable().default(1),
      counting: z.enum(["best", "latest", "first"]).default("best"),
    })
    .default({ maxAttempts: 1, counting: "best" }),
  groups: z.array(RoundGroupSchema).max(50),
});

export const GroupSchema = z.object({
  id: z.uuid(),
  key: zKey,
  name: zI18nText,
  eligibility: EligibilityRuleSchema,
  capacity: z.number().int().min(1).nullable().default(null),
});

export const CompetitionConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  groups: z.array(GroupSchema).min(1).max(50),
  rounds: z.array(RoundSchema).min(1).max(20),
});

export type CompetitionConfig = z.output<typeof CompetitionConfigSchema>;
export type CompetitionConfigInput = z.input<typeof CompetitionConfigSchema>;
export type RoundConfig = CompetitionConfig["rounds"][number];
export type RoundGroupConfig = RoundConfig["groups"][number];
export type GroupConfig = CompetitionConfig["groups"][number];
