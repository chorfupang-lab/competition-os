import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  FEEDBACK_JSON_SCHEMA,
  PronunciationAssessmentSchema,
  feedbackPrompt,
  type FeedbackFacts,
  type PronunciationAssessment,
} from "@cos/core";

/**
 * AI provider adapters. The platform never hard-codes one model: providers
 * are chosen by configuration and can be swapped (hard rule 14). Every
 * provider's output is validated again by the caller before use.
 */

export interface PronunciationRequest {
  audio: Buffer;
  mimeType: string;
  targetText: string;
  speechLanguage: string;
  romanization?: string | null;
  aspects: string[];
}

export interface PronunciationResult {
  assessment: PronunciationAssessment;
  provider: string;
  model: string | null;
  audioMs: number;
}

export interface PronunciationProvider {
  readonly name: string;
  assess(req: PronunciationRequest): Promise<PronunciationResult>;
}

/**
 * Deterministic stand-in for development and tests: scores derive from a
 * hash of the audio, so the same recording always gets the same result.
 */
export class MockPronunciationProvider implements PronunciationProvider {
  readonly name = "mock";
  failNext = 0;
  calls = 0;
  async assess(req: PronunciationRequest): Promise<PronunciationResult> {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("mock provider unavailable");
    }
    const h = createHash("sha256").update(req.audio).digest();
    const score = (i: number) => 40 + (h[i]! % 61);
    const aspects = Object.fromEntries(req.aspects.map((a, i) => [a, score(i)]));
    const values = Object.values(aspects) as number[];
    const overall = values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : score(0);
    const units = [...req.targetText].filter((c) => c.trim()).slice(0, 50).map((c, i) => ({ text: c, score: score(10 + (i % 20)) }));
    return { assessment: PronunciationAssessmentSchema.parse({ overall, aspects, units, durationMs: req.audio.length * 2 }), provider: this.name, model: "mock-v1", audioMs: req.audio.length * 2 };
  }
}

/**
 * Generic HTTP adapter for a pronunciation service (self-hosted open model
 * or a vendor API behind a thin proxy). Contract, in docs/ai.md:
 *   POST {url}  { audioBase64, mimeType, targetText, speechLanguage, romanization, aspects }
 *   → 200 { overall, aspects: {…}, units: [...], durationMs, model }
 */
export class HttpPronunciationProvider implements PronunciationProvider {
  readonly name = "http";
  constructor(private readonly url: string, private readonly token: string | null, private readonly timeoutMs = 30_000) {}
  async assess(req: PronunciationRequest): Promise<PronunciationResult> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token && { authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify({ audioBase64: req.audio.toString("base64"), mimeType: req.mimeType, targetText: req.targetText, speechLanguage: req.speechLanguage, romanization: req.romanization ?? null, aspects: req.aspects }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`pronunciation service ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const assessment = PronunciationAssessmentSchema.parse(body);
    return { assessment, provider: this.name, model: typeof body.model === "string" ? body.model : null, audioMs: assessment.durationMs ?? 0 };
  }
}

export interface FeedbackGeneration {
  raw: unknown;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface FeedbackProvider {
  readonly name: string;
  generate(facts: FeedbackFacts): Promise<FeedbackGeneration>;
}

/** No LLM: the caller's deterministic template is the feedback. */
export class TemplateFeedbackProvider implements FeedbackProvider {
  readonly name = "template";
  async generate(): Promise<FeedbackGeneration> {
    return { raw: null, provider: this.name, model: null, inputTokens: 0, outputTokens: 0, costMicros: 0 };
  }
}

/**
 * Claude, via the Anthropic SDK, with a JSON-schema output format. Server-side
 * refusal fallbacks are on; a refusal or any invalid output still ends in the
 * deterministic fallback after validation.
 */
export class ClaudeFeedbackProvider implements FeedbackProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  constructor(private readonly model: string, private readonly pricing: { inputPerMTok: number; outputPerMTok: number }, client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }
  async generate(facts: FeedbackFacts): Promise<FeedbackGeneration> {
    const prompt = feedbackPrompt(facts);
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: FEEDBACK_JSON_SCHEMA as unknown as Record<string, unknown> } },
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    });
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costMicros = Math.round(inputTokens * this.pricing.inputPerMTok + outputTokens * this.pricing.outputPerMTok);
    let raw: unknown = null;
    if (response.stop_reason !== "refusal") {
      const text = response.content.find((b) => b.type === "text");
      if (text && text.type === "text") {
        try {
          raw = JSON.parse(text.text);
        } catch {
          raw = null;
        }
      }
    }
    return { raw, provider: this.name, model: response.model, inputTokens, outputTokens, costMicros };
  }
}
