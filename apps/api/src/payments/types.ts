/**
 * Payment provider adapter. The platform talks to every gateway through this
 * interface, so providers can be added or swapped (hard rule 26). Checkout is
 * always hosted by the provider; card data never reaches this system.
 */
export type ProviderName = "airwallex" | "test";

export interface CheckoutRequest {
  /** The tenant's merchant account at the provider (tenant is the merchant). */
  merchantAccountId: string;
  orderId: string;
  orderNumber: string;
  /** Unique per attempt; the provider uses it to de-duplicate retries. */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  description: string;
  returnUrl: string;
  metadata: Record<string, string>;
}

/** What the browser needs to open the provider's hosted checkout. */
export type CheckoutSession =
  | { kind: "redirect"; url: string }
  | { kind: "airwallex_hpp"; intentId: string; clientSecret: string; currency: string; env: "demo" | "prod" };

export interface CheckoutResult {
  providerPaymentId: string;
  checkout: CheckoutSession;
}

export interface RefundRequest {
  merchantAccountId: string;
  providerPaymentId: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  reason: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: "pending" | "succeeded" | "failed";
}

/** A verified webhook, normalized across providers. */
export interface PaymentEvent {
  eventId: string;
  rawType: string;
  type: "payment.succeeded" | "payment.failed" | "payment.cancelled" | "refund.succeeded" | "refund.failed" | "ignored";
  providerPaymentId?: string;
  providerRefundId?: string;
  amountMinor?: number;
  currency?: string;
  feeMinor?: number;
  failureCode?: string;
}

export interface SettledTransaction {
  providerTxnId: string;
  kind: "payment" | "refund";
  providerRef: string;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  settledAt: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  /** Verify the signature on the raw body and normalize the event. Throws WebhookSignatureError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent;
  /** Settled transactions for reconciliation. */
  listSettledTransactions(merchantAccountId: string, from: Date, to: Date): Promise<SettledTransaction[]>;
}

export class WebhookSignatureError extends Error {}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}
