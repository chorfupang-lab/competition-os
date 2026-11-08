import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { validateFeedback, type FeedbackFacts } from "@cos/core";
import { ClaudeFeedbackProvider } from "../src/ai/providers.ts";

const facts: FeedbackFacts = {
  locale: "zh-Hant", firstName: "Mei", accuracy: 0.6, totalScore: 6, maxScore: 10,
  strengths: [{ id: "s1", name: "聲調", mastery: 0.9 }], weaknesses: [{ id: "s2", name: "韻母", mastery: 0.3 }],
  practiceCandidates: [{ id: "i1", label: "P-1" }],
};

function stubClient(response: Record<string, unknown>) {
  const calls: unknown[] = [];
  const client = { beta: { messages: { create: async (params: unknown) => { calls.push(params); return response; } } } } as unknown as Anthropic;
  return { client, calls };
}

describe("Claude feedback adapter", () => {
  it("requests structured JSON with refusal fallbacks, and tracks cost", async () => {
    const out = { summary: "聲調很好，韻母可以多練習。", strengthSkillIds: ["s1"], weaknessSkillIds: ["s2"], encouragement: "繼續加油！", recommendedItemIds: ["i1"] };
    const { client, calls } = stubClient({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 1000, output_tokens: 200 } });
    const provider = new ClaudeFeedbackProvider("claude-opus-5-5", { inputPerMTok: 4, outputPerMTok: 20 }, client);
    const gen = await provider.generate(facts);
    const params = calls[0] as Record<string, any>;
    expect(params).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(params.system).toContain("Traditional Chinese");
    expect(JSON.parse(params.messages[0].content)).toMatchObject({ accuracyPercent: 60, practiceItems: [{ id: "i1" }] });
    expect(gen).toMatchObject({ raw: out, inputTokens: 1000, outputTokens: 200, costMicros: 8000 });
    expect(validateFeedback(gen.raw, facts).source).toBe("ai");
  });

  it("a refusal or unparseable text yields no output, so validation falls back", async () => {
    for (const response of [
      { model: "claude-opus-5-5", stop_reason: "refusal", content: [], usage: { input_tokens: 10, output_tokens: 0 } },
      { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "not json" }], usage: { input_tokens: 10, output_tokens: 5 } },
    ]) {
      const { client } = stubClient(response);
      const gen = await new ClaudeFeedbackProvider("claude-opus-5-5", { inputPerMTok: 4, outputPerMTok: 20 }, client).generate(facts);
      expect(gen.raw).toBeNull();
      expect(validateFeedback(gen.raw, facts).source).toBe("fallback");
    }
  });
});
