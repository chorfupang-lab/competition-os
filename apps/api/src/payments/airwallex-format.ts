import { createHmac, timingSafeEqual } from "node:crypto";
import { decimalToMinor } from "@cos/core";
import { WebhookSignatureError, type PaymentEvent } from "./types.ts";

/**
 * Airwallex webhook format, shared by the real adapter and the test provider
 * (which emits Airwallex-shaped events so this code path is exercised in tests).
 *
 * Signature: hex HMAC-SHA256 over `x-timestamp` + raw body, keyed with the
 * endpoint's secret, in `x-signature`. Deliveries older than the tolerance
 * are rejected to prevent replays.
 */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export function signAirwallexPayload(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
}

const header = (h: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export function verifyAirwallexSignature(secret: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): void {
  const timestamp = header(headers, "x-timestamp");
  const signature = header(headers, "x-signature");
  if (!timestamp || !signature) throw new WebhookSignatureError("missing signature headers");
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_MS) throw new WebhookSignatureError("timestamp outside tolerance");
  const expected = Buffer.from(signAirwallexPayload(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError("signature mismatch");
}

interface AirwallexEvent {
  id: string;
  name: string;
  data?: { object?: Record<string, unknown> };
}

const PAYMENT_SUCCEEDED = new Set(["payment_intent.succeeded"]);
const PAYMENT_CANCELLED = new Set(["payment_intent.cancelled"]);
const PAYMENT_FAILED = new Set(["payment_attempt.failed_to_process", "payment_attempt.authorization_failed", "payment_attempt.capture_failed", "payment_intent.failed"]);
const REFUND_SUCCEEDED = new Set(["refund.settled", "refund.succeeded"]);
const REFUND_FAILED = new Set(["refund.failed"]);

export function normalizeAirwallexEvent(rawBody: Buffer): PaymentEvent {
  let event: AirwallexEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as AirwallexEvent;
  } catch {
    throw new WebhookSignatureError("body is not JSON");
  }
  if (typeof event.id !== "string" || typeof event.name !== "string") throw new WebhookSignatureError("not an event");
  const o = event.data?.object ?? {};
  const currency = typeof o.currency === "string" ? o.currency.toUpperCase() : undefined;
  const money = (v: unknown) => (currency && (typeof v === "number" || typeof v === "string") ? decimalToMinor(v, currency) : undefined);
  const base = { eventId: event.id, rawType: event.name, ...(currency && { currency }) };

  if (PAYMENT_SUCCEEDED.has(event.name) || PAYMENT_CANCELLED.has(event.name) || PAYMENT_FAILED.has(event.name)) {
    const intentId = (event.name.startsWith("payment_attempt.") ? o.payment_intent_id : o.id) as string | undefined;
    const type = PAYMENT_SUCCEEDED.has(event.name) ? "payment.succeeded" : PAYMENT_CANCELLED.has(event.name) ? "payment.cancelled" : "payment.failed";
    return {
      ...base,
      type,
      ...(intentId && { providerPaymentId: intentId }),
      ...(money(o.amount) !== undefined && { amountMinor: money(o.amount)! }),
      ...(money(o.fee) !== undefined && { feeMinor: money(o.fee)! }),
      ...(typeof o.failure_code === "string" && { failureCode: o.failure_code }),
    };
  }
  if (REFUND_SUCCEEDED.has(event.name) || REFUND_FAILED.has(event.name)) {
    return {
      ...base,
      type: REFUND_SUCCEEDED.has(event.name) ? "refund.succeeded" : "refund.failed",
      ...(typeof o.id === "string" && { providerRefundId: o.id }),
      ...(typeof o.payment_intent_id === "string" && { providerPaymentId: o.payment_intent_id }),
      ...(money(o.amount) !== undefined && { amountMinor: money(o.amount)! }),
    };
  }
  return { ...base, type: "ignored" };
}
