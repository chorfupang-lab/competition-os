import { decimalToMinor, minorToDecimal } from "@cos/core";
import { normalizeAirwallexEvent, verifyAirwallexSignature } from "./airwallex-format.ts";
import { ProviderError, type CheckoutRequest, type CheckoutResult, type PaymentEvent, type PaymentProvider, type RefundRequest, type RefundResult, type SettledTransaction } from "./types.ts";

/**
 * Airwallex adapter (initial HK-oriented provider, hard rule 27).
 *
 * The platform's API key authenticates; each request acts for the tenant's
 * connected account via `x-on-behalf-of`, so the tenant is the merchant.
 * Checkout uses Airwallex's Hosted Payment Page: the browser redirects with
 * the intent id and client secret returned here.
 *
 * NOT YET VERIFIED against the Airwallex sandbox: endpoint paths and event
 * names follow Airwallex's public API reference and must be confirmed with
 * real credentials before go-live (see docs/payments.md).
 */
export interface AirwallexConfig {
  baseUrl: string; // https://api-demo.airwallex.com or https://api.airwallex.com
  clientId: string;
  apiKey: string;
  webhookSecret: string;
  env: "demo" | "prod";
  timeoutMs?: number;
}

export class AirwallexProvider implements PaymentProvider {
  readonly name = "airwallex" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: AirwallexConfig) {}

  private async authToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetch("/api/v1/authentication/login", { method: "POST", headers: { "x-client-id": this.config.clientId, "x-api-key": this.config.apiKey } }, false);
    const body = (await res.json()) as { token: string; expires_at?: string };
    this.token = { value: body.token, expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 25 * 60_000 };
    return body.token;
  }

  private async fetch(path: string, init: RequestInit, auth = true, onBehalfOf?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (auth) headers.set("authorization", `Bearer ${await this.authToken()}`);
    if (onBehalfOf && onBehalfOf !== "platform") headers.set("x-on-behalf-of", onBehalfOf);
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000) });
    } catch (err) {
      throw new ProviderError(`airwallex request failed: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`airwallex ${path} → ${res.status} ${text.slice(0, 300)}`, res.status >= 500 || res.status === 429);
    }
    return res;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const res = await this.fetch(
      "/api/v1/pa/payment_intents/create",
      {
        method: "POST",
        body: JSON.stringify({
          request_id: req.idempotencyKey,
          amount: Number(minorToDecimal(req.amountMinor, req.currency)),
          currency: req.currency,
          merchant_order_id: req.orderNumber,
          descriptor: req.description.slice(0, 32),
          return_url: req.returnUrl,
          metadata: req.metadata,
        }),
      },
      true,
      req.merchantAccountId,
    );
    const intent = (await res.json()) as { id: string; client_secret: string };
    return { providerPaymentId: intent.id, checkout: { kind: "airwallex_hpp", intentId: intent.id, clientSecret: intent.client_secret, currency: req.currency, env: this.config.env } };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const res = await this.fetch(
      "/api/v1/pa/refunds/create",
      {
        method: "POST",
        body: JSON.stringify({ request_id: req.idempotencyKey, payment_intent_id: req.providerPaymentId, amount: Number(minorToDecimal(req.amountMinor, req.currency)), reason: req.reason.slice(0, 128) }),
      },
      true,
      req.merchantAccountId,
    );
    const refund = (await res.json()) as { id: string; status: string };
    const status = refund.status === "SUCCEEDED" || refund.status === "SETTLED" ? "succeeded" : refund.status === "FAILED" ? "failed" : "pending";
    return { providerRefundId: refund.id, status };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    verifyAirwallexSignature(this.config.webhookSecret, rawBody, headers);
    return normalizeAirwallexEvent(rawBody);
  }

  async listSettledTransactions(merchantAccountId: string, from: Date, to: Date): Promise<SettledTransaction[]> {
    const out: SettledTransaction[] = [];
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ from_created_at: from.toISOString(), to_created_at: to.toISOString(), page_num: String(page), page_size: "200" });
      const res = await this.fetch(`/api/v1/financial_transactions?${q}`, { method: "GET" }, true, merchantAccountId);
      const body = (await res.json()) as { items: Array<Record<string, unknown>>; has_more?: boolean };
      for (const t of body.items) {
        const currency = String(t.currency ?? "").toUpperCase();
        const type = String(t.transaction_type ?? "").toUpperCase();
        if (!currency || (type !== "PAYMENT" && type !== "REFUND")) continue;
        out.push({
          providerTxnId: String(t.id),
          kind: type === "REFUND" ? "refund" : "payment",
          providerRef: String(t.source_id ?? t.id),
          amountMinor: Math.abs(decimalToMinor(String(t.amount ?? 0), currency)),
          feeMinor: Math.abs(decimalToMinor(String(t.fee ?? 0), currency)),
          currency,
          settledAt: String(t.settled_at ?? t.created_at),
        });
      }
      if (!body.has_more) break;
    }
    return out;
  }
}
