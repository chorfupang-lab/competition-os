import { z } from "zod";
import type { Locale } from "../locales.ts";

/**
 * AI feedback: the only things AI may produce for a student (section 13 of
 * the requirements) are score analysis, approved skill strengths and
 * weaknesses, explanations, practice recommendations from the approved
 * content bank, and encouragement. It never changes official outcomes.
 *
 * Pipeline:  provider output → schema validation → reference checks → safety filter → display
 * Anything that fails falls back to deterministic template text.
 */

/** The facts we give the model: everything is pre-computed and approved. */
export interface FeedbackFacts {
  locale: Locale;
  firstName: string | null;
  /** 0..1, provisional or official; the model only describes it. */
  accuracy: number;
  totalScore: number;
  maxScore: number;
  /** Approved skills only (from the tenant's skill framework). */
  strengths: Array<{ id: string; name: string; mastery: number }>;
  weaknesses: Array<{ id: string; name: string; mastery: number }>;
  /** Approved practice items the model may recommend (and nothing else). */
  practiceCandidates: Array<{ id: string; label: string }>;
}

export const FeedbackOutputSchema = z.object({
  summary: z.string().min(10).max(600),
  strengthSkillIds: z.array(z.string()).max(5),
  weaknessSkillIds: z.array(z.string()).max(5),
  encouragement: z.string().min(5).max(300),
  recommendedItemIds: z.array(z.string()).max(10),
});
export type FeedbackOutput = z.infer<typeof FeedbackOutputSchema>;

/** JSON Schema of the output, for providers that support constrained output. */
export const FEEDBACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "strengthSkillIds", "weaknessSkillIds", "encouragement", "recommendedItemIds"],
  properties: {
    summary: { type: "string" },
    strengthSkillIds: { type: "array", items: { type: "string" } },
    weaknessSkillIds: { type: "array", items: { type: "string" } },
    encouragement: { type: "string" },
    recommendedItemIds: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * Content the platform must never show a student, whatever the model says:
 * diagnoses (health, psychology, personality, learning difficulties),
 * medical/legal/financial advice, external links or contacts, personal data,
 * and claims about official outcomes.
 */
const BLOCKED: Array<{ code: string; pattern: RegExp }> = [
  { code: "external_link", pattern: /\bhttps?:\/\/|\bwww\.|\.(com|net|org|io|hk|cn|th)\b/i },
  { code: "contact_details", pattern: /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{7,}\d/ },
  { code: "diagnosis", pattern: /\b(diagnos\w*|disorder|adhd|autis\w*|dyslexi\w*|depress\w*|anxiety|syndrome|disabilit\w*|iq\b|personality type|introvert|extrovert)\b|多動|自閉|讀寫障礙|读写障碍|抑鬱|抑郁|焦慮|焦虑|โรคสมาธิสั้น|ออทิสติก|ภาวะซึมเศร้า/i },
  { code: "professional_advice", pattern: /\b(doctor|therapist|therapy|medication|medicine|lawyer|legal advice|invest\w*|loan|financial advice)\b|醫生|医生|律師|律师|投資|投资|แพทย์|ทนาย|การลงทุน/i },
  { code: "official_outcome", pattern: /\b(disqualif\w*|qualif\w* for|you (will|have) (win|won|pass|passed|fail|failed)|official (score|result|rank))\b|取消資格|取消资格|晉級|晋级|ตัดสิทธิ์/i },
  { code: "chat_invitation", pattern: /\b(ask me|chat with me|talk to me|message me|tell me more about yourself)\b/i },
];

export interface SafetyResult {
  ok: boolean;
  violations: string[];
}

export function safetyCheck(texts: readonly string[]): SafetyResult {
  const violations = new Set<string>();
  for (const t of texts) for (const b of BLOCKED) if (b.pattern.test(t)) violations.add(b.code);
  return { ok: violations.size === 0, violations: [...violations].sort() };
}

export type ValidatedFeedback =
  | { source: "ai"; feedback: FeedbackOutput }
  | { source: "fallback"; feedback: FeedbackOutput; reasons: string[] };

/** Validate a provider's raw output against the schema, the provided facts, and the safety filter. */
export function validateFeedback(raw: unknown, facts: FeedbackFacts): ValidatedFeedback {
  const reasons: string[] = [];
  const parsed = FeedbackOutputSchema.safeParse(raw);
  if (!parsed.success) return { source: "fallback", feedback: fallbackFeedback(facts), reasons: ["schema_invalid"] };
  const out = parsed.data;
  const allowedSkills = new Set([...facts.strengths, ...facts.weaknesses].map((s) => s.id));
  const strengthIds = new Set(facts.strengths.map((s) => s.id));
  const weaknessIds = new Set(facts.weaknesses.map((s) => s.id));
  const items = new Set(facts.practiceCandidates.map((p) => p.id));
  if (out.strengthSkillIds.some((id) => !allowedSkills.has(id) || !strengthIds.has(id))) reasons.push("unknown_or_misplaced_strength");
  if (out.weaknessSkillIds.some((id) => !allowedSkills.has(id) || !weaknessIds.has(id))) reasons.push("unknown_or_misplaced_weakness");
  if (out.recommendedItemIds.some((id) => !items.has(id))) reasons.push("unapproved_recommendation");
  const safety = safetyCheck([out.summary, out.encouragement]);
  if (!safety.ok) reasons.push(...safety.violations.map((v) => `unsafe:${v}`));
  if (reasons.length) return { source: "fallback", feedback: fallbackFeedback(facts), reasons };
  return { source: "ai", feedback: out };
}

const TEMPLATES: Record<Locale, { summary: (pct: number, s: string, w: string) => string; encouragement: string; none: string }> = {
  en: {
    summary: (pct, s, w) => `You answered ${pct}% of the questions correctly. Strongest: ${s}. To practise next: ${w}.`,
    encouragement: "Well done for taking part — keep practising and you will keep improving!",
    none: "keep building on everything",
  },
  "zh-Hant": {
    summary: (pct, s, w) => `你答對了 ${pct}% 的題目。表現最好：${s}。下一步可練習：${w}。`,
    encouragement: "感謝你的參與！繼續練習，你會越來越進步！",
    none: "繼續鞏固各方面",
  },
  "zh-Hans": {
    summary: (pct, s, w) => `你答对了 ${pct}% 的题目。表现最好：${s}。下一步可练习：${w}。`,
    encouragement: "感谢你的参与！继续练习，你会越来越进步！",
    none: "继续巩固各方面",
  },
  th: {
    summary: (pct, s, w) => `คุณตอบถูก ${pct}% ของคำถามทั้งหมด จุดเด่น: ${s} ควรฝึกต่อ: ${w}`,
    encouragement: "เก่งมากที่เข้าร่วม ฝึกฝนต่อไปแล้วจะพัฒนาขึ้นเรื่อยๆ!",
    none: "ฝึกฝนทุกด้านต่อไป",
  },
};

/** Deterministic feedback from the same facts; always safe, always available. */
export function fallbackFeedback(f: FeedbackFacts): FeedbackOutput {
  const t = TEMPLATES[f.locale];
  const s = f.strengths.slice(0, 3).map((x) => x.name).join(", ") || t.none;
  const w = f.weaknesses.slice(0, 3).map((x) => x.name).join(", ") || t.none;
  return {
    summary: t.summary(Math.round(f.accuracy * 100), s, w),
    strengthSkillIds: f.strengths.slice(0, 3).map((x) => x.id),
    weaknessSkillIds: f.weaknesses.slice(0, 3).map((x) => x.id),
    encouragement: t.encouragement,
    recommendedItemIds: f.practiceCandidates.slice(0, 5).map((p) => p.id),
  };
}

/** The instruction for LLM providers. Facts are data; the model only phrases them. */
export function feedbackPrompt(f: FeedbackFacts): { system: string; user: string } {
  const language = { en: "English", "zh-Hant": "Traditional Chinese", "zh-Hans": "Simplified Chinese", th: "Thai" }[f.locale];
  return {
    system: [
      "You write short, warm feedback for a school student after a learning competition.",
      `Write in ${language}, at a level a primary-school child understands.`,
      "Use only the facts provided. Choose strengths and weaknesses only from the listed skill ids, and recommend only listed practice item ids.",
      "Never diagnose or label the child (health, learning, personality), never give medical, legal or financial advice, never mention official results, qualification or disqualification, never include links or contact details, and never invite the student to chat.",
      "Return only the JSON object.",
    ].join(" "),
    user: JSON.stringify({
      firstName: f.firstName,
      accuracyPercent: Math.round(f.accuracy * 100),
      score: `${f.totalScore}/${f.maxScore}`,
      strengths: f.strengths.map((s) => ({ id: s.id, name: s.name })),
      weaknesses: f.weaknesses.map((s) => ({ id: s.id, name: s.name })),
      practiceItems: f.practiceCandidates,
    }),
  };
}
