import { describe, expect, it } from "vitest";
import { normalizeAirwallexEvent, signAirwallexPayload, verifyAirwallexSignature } from "../src/payments/airwallex-format.ts";
import { WebhookSignatureError } from "../src/payments/types.ts";

const secret = "whsec_unit";
const body = (name: string, object: Record<string, unknown>) => Buffer.from(JSON.stringify({ id: "evt_1", name, data: { object } }));

describe("Airwallex webhook signatures", () => {
  it("accepts HMAC-SHA256(timestamp + raw body) and rejects tampering, wrong secrets and stale timestamps", () => {
    const raw = body("payment_intent.succeeded", { id: "int_1", amount: 300, currency: "HKD" });
    const ts = String(Date.now());
    const headers = { "x-timestamp": ts, "x-signature": signAirwallexPayload(secret, ts, raw) };
    expect(() => verifyAirwallexSignature(secret, raw, headers)).not.toThrow();
    expect(() => verifyAirwallexSignature(secret, Buffer.from(raw.toString().replace("300", "3")), headers)).toThrow(WebhookSignatureError);
    expect(() => verifyAirwallexSignature("other", raw, headers)).toThrow(WebhookSignatureError);
    expect(() => verifyAirwallexSignature(secret, raw, { "x-timestamp": ts })).toThrow(/missing/);
    const old = String(Date.now() - 6 * 60_000);
    expect(() => verifyAirwallexSignature(secret, raw, { "x-timestamp": old, "x-signature": signAirwallexPayload(secret, old, raw) })).toThrow(/tolerance/);
  });
});

describe("Airwallex event normalization", () => {
  it("maps payment and refund events, converting decimal amounts to minor units", () => {
    expect(normalizeAirwallexEvent(body("payment_intent.succeeded", { id: "int_1", amount: 300.5, currency: "hkd", fee: 9.3 }))).toEqual({
      eventId: "evt_1", rawType: "payment_intent.succeeded", type: "payment.succeeded", providerPaymentId: "int_1", amountMinor: 30050, currency: "HKD", feeMinor: 930,
    });
    expect(normalizeAirwallexEvent(body("payment_attempt.authorization_failed", { id: "att_1", payment_intent_id: "int_1", failure_code: "card_declined" }))).toMatchObject({
      type: "payment.failed", providerPaymentId: "int_1", failureCode: "card_declined",
    });
    expect(normalizeAirwallexEvent(body("refund.settled", { id: "rf_1", payment_intent_id: "int_1", amount: 100, currency: "THB" }))).toMatchObject({
      type: "refund.succeeded", providerRefundId: "rf_1", amountMinor: 10000,
    });
    expect(normalizeAirwallexEvent(body("payout.created", {})).type).toBe("ignored");
    expect(() => normalizeAirwallexEvent(Buffer.from("not json"))).toThrow(WebhookSignatureError);
  });
});
