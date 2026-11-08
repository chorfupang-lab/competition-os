/**
 * Payment reconciliation: system records ↔ the gateway's settled transactions.
 *   matched   – a gateway transaction with the same amount and currency
 *   unsettled – we recorded success but the gateway has not reported it yet
 *   mismatch  – amount or currency differ, or a gateway transaction has no system record
 */
export interface SystemPayment {
  kind: "payment" | "refund";
  /** The provider's id for the payment or refund. */
  providerRef: string;
  orderId: string;
  amountMinor: number;
  currency: string;
}

export interface GatewayTransaction {
  kind: "payment" | "refund";
  providerRef: string;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  settledAt: string;
}

export type ReconciliationStatus = "matched" | "unsettled" | "mismatch";

export interface ReconciliationRow {
  status: ReconciliationStatus;
  kind: "payment" | "refund";
  providerRef: string;
  orderId: string | null;
  systemAmountMinor: number | null;
  gatewayAmountMinor: number | null;
  feeMinor: number | null;
  currency: string;
  reason?: "amount_differs" | "currency_differs" | "no_system_record";
}

export function reconcile(system: readonly SystemPayment[], gateway: readonly GatewayTransaction[]): ReconciliationRow[] {
  const byRef = new Map(gateway.map((g) => [`${g.kind}:${g.providerRef}`, g]));
  const used = new Set<string>();
  const rows: ReconciliationRow[] = system.map((s) => {
    const key = `${s.kind}:${s.providerRef}`;
    const g = byRef.get(key);
    const base = { kind: s.kind, providerRef: s.providerRef, orderId: s.orderId, systemAmountMinor: s.amountMinor, currency: s.currency };
    if (!g) return { ...base, status: "unsettled", gatewayAmountMinor: null, feeMinor: null };
    used.add(key);
    const common = { ...base, gatewayAmountMinor: g.amountMinor, feeMinor: g.feeMinor };
    if (g.currency !== s.currency) return { ...common, status: "mismatch", reason: "currency_differs" };
    if (g.amountMinor !== s.amountMinor) return { ...common, status: "mismatch", reason: "amount_differs" };
    return { ...common, status: "matched" };
  });
  for (const g of gateway) {
    if (used.has(`${g.kind}:${g.providerRef}`)) continue;
    rows.push({ status: "mismatch", reason: "no_system_record", kind: g.kind, providerRef: g.providerRef, orderId: null, systemAmountMinor: null, gatewayAmountMinor: g.amountMinor, feeMinor: g.feeMinor, currency: g.currency });
  }
  return rows;
}

/** Gross − gateway fees − platform fee − refunds = tenant net (all in minor units). */
export function tenantNet(x: { grossMinor: number; gatewayFeeMinor: number; platformFeeMinor: number; refundedMinor: number }): number {
  return x.grossMinor - x.gatewayFeeMinor - x.platformFeeMinor - x.refundedMinor;
}
