import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@cos/core";
import { handlePaymentEvent } from "../lib/payments.ts";
import { parse } from "../lib/validation.ts";
import { WebhookSignatureError, type ProviderName } from "../payments/index.ts";

/**
 * Payment webhooks. The raw body is kept for signature verification; events
 * are recorded once and applied idempotently, so provider retries are safe.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const { db, providers } = app.deps;
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/payments/:provider", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { provider: name } = parse(z.object({ provider: z.enum(["airwallex", "test"]) }), request.params);
    const provider = providers.get(name as ProviderName);
    if (!provider) throw new AppError("NOT_FOUND");
    if (!Buffer.isBuffer(request.body)) throw new AppError("VALIDATION_FAILED");
    let event;
    try {
      event = provider.parseWebhook(request.body, request.headers);
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        request.log.warn({ provider: name, reason: err.message }, "rejected webhook");
        return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "invalid signature" } });
      }
      throw err;
    }
    const outcome = await handlePaymentEvent(db, request, name as ProviderName, event);
    return { received: true, outcome };
  });
}
