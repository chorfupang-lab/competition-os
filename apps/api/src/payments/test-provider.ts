import { randomUUID } from "node:crypto";
import { minorToDecimal } from "@cos/core";
import { normalizeAirwallexEvent, signAirwallexPayload, verifyAirwallexSignature } from "./airwallex-format.ts";
import type { CheckoutRequest, CheckoutResult, PaymentEvent, PaymentProvider, RefundRequest, RefundResult, SettledTransaction } from "./types.ts";

/**
 * Test provider for development and automated tests. It behaves like
 * Airwallex: same webhook format and signature scheme, asynchronous outcomes
 * via webhooks. Disabled in production (see config).
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = "test" as const;
  readonly checkouts: CheckoutRequest[] = [];
  readonly refunds: RefundRequest[] = [];
  settled: SettledTransaction[] = [];
  /** Make the next createCheckout / refund throw, to test provider outages. */
  failNext: "checkout" | "refund" | null = null;

  constructor(readonly webhookSecret: string, private readonly appUrl: string) {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (this.failNext === "checkout") {
      this.failNext = null;
      throw new Error("test provider: checkout unavailable");
    }
    this.checkouts.push(req);
    const id = `test_pi_${randomUUID()}`;
    return { providerPaymentId: id, checkout: { kind: "redirect", url: `${this.appUrl}/test-checkout/${id}` } };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    if (this.failNext === "refund") {
      this.failNext = null;
      throw new Error("test provider: refund unavailable");
    }
    this.refunds.push(req);
    return { providerRefundId: `test_rf_${randomUUID()}`, status: "pending" };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    verifyAirwallexSignature(this.webhookSecret, rawBody, headers);
    return normalizeAirwallexEvent(rawBody);
  }

  async listSettledTransactions(): Promise<SettledTransaction[]> {
    return this.settled;
  }

  /** Build a signed Airwallex-style webhook delivery (body + headers). */
  webhook(name: string, object: Record<string, unknown>, opts: { eventId?: string; timestamp?: number; secret?: string } = {}) {
    const body = JSON.stringify({ id: opts.eventId ?? `evt_${randomUUID()}`, name, created_at: new Date().toISOString(), data: { object } });
    const ts = String(opts.timestamp ?? Date.now());
    return {
      body,
      headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signAirwallexPayload(opts.secret ?? this.webhookSecret, ts, body) },
    };
  }

  static amount(minor: number, currency: string): number {
    return Number(minorToDecimal(minor, currency));
  }
}
