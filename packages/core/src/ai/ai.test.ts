import { describe, expect, it } from "vitest";
import { fallbackFeedback, safetyCheck, suggestedFraction, validateFeedback, type FeedbackFacts } from "../index.ts";

const facts: FeedbackFacts = {
  locale: "en",
  firstName: "Mei",
  accuracy: 0.72,
  totalScore: 18,
  maxScore: 25,
  strengths: [{ id: "s-tones", name: "Tones", mastery: 0.9 }],
  weaknesses: [{ id: "s-finals", name: "Finals", mastery: 0.4 }],
  practiceCandidates: [{ id: "item-1", label: "Finals: -ang / -an" }],
};
const good = { summary: "Great tones! Finals like -ang need a little more practice.", strengthSkillIds: ["s-tones"], weaknessSkillIds: ["s-finals"], encouragement: "Keep going, Mei!", recommendedItemIds: ["item-1"] };

describe("AI feedback validation", () => {
  it("accepts valid, safe output that only uses provided ids", () => {
    expect(validateFeedback(good, facts)).toEqual({ source: "ai", feedback: good });
  });

  it("falls back on schema errors, invented ids and unsafe text", () => {
    expect(validateFeedback({ summary: "hi" }, facts)).toMatchObject({ source: "fallback", reasons: ["schema_invalid"] });
    expect(validateFeedback({ ...good, recommendedItemIds: ["https-item"] }, facts)).toMatchObject({ source: "fallback", reasons: ["unapproved_recommendation"] });
    expect(validateFeedback({ ...good, strengthSkillIds: ["s-finals"] }, facts)).toMatchObject({ source: "fallback", reasons: ["unknown_or_misplaced_strength"] });
    const unsafe = [
      ["Mei may have ADHD, see a doctor.", ["unsafe:diagnosis", "unsafe:professional_advice"]],
      ["Practise more at www.example.com", ["unsafe:external_link"]],
      ["You have qualified for the final!", ["unsafe:official_outcome"]],
      ["Ask me anything, I can chat with me any time", ["unsafe:chat_invitation"]],
      ["Call +852 9123 4567 for tutoring", ["unsafe:contact_details"]],
      ["老師認為你可能有讀寫障礙，需要留意。", ["unsafe:diagnosis"]],
    ] as const;
    for (const [summary, reasons] of unsafe) {
      const r = validateFeedback({ ...good, summary }, facts);
      expect(r.source, summary).toBe("fallback");
      expect((r as { reasons: string[] }).reasons).toEqual(reasons);
    }
  });

  it("fallback text is deterministic, localized and passes its own safety check", () => {
    for (const locale of ["en", "zh-Hant", "zh-Hans", "th"] as const) {
      const fb = fallbackFeedback({ ...facts, locale });
      expect(fb.strengthSkillIds).toEqual(["s-tones"]);
      expect(fb.recommendedItemIds).toEqual(["item-1"]);
      expect(safetyCheck([fb.summary, fb.encouragement]).ok).toBe(true);
      expect(fallbackFeedback({ ...facts, locale })).toEqual(fb);
    }
    expect(fallbackFeedback(facts).summary).toBe("You answered 72% of the questions correctly. Strongest: Tones. To practise next: Finals.");
  });
});

describe("pronunciation rubric", () => {
  const a = { overall: 70, aspects: { tones: 90, finals: 50 }, units: [] };
  it("maps measured aspects to a suggested fraction", () => {
    expect(suggestedFraction(a, ["tones"])).toBe(1);
    expect(suggestedFraction(a, ["finals"])).toBe(0.22);
    expect(suggestedFraction(a, ["tones", "finals"])).toBe(0.67);
    expect(suggestedFraction(a, ["fluency"])).toBe(0.67); // missing aspect uses overall
    expect(suggestedFraction({ overall: 30, aspects: {}, units: [] }, ["tones"])).toBe(0);
  });
});
