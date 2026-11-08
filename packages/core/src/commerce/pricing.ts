import { applyBps } from "./money.ts";

/** A price row: optionally limited to a group and a time window (e.g. early bird). */
export interface PriceRule {
  id: string;
  groupId: string | null;
  amountMinor: number;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * The price that applies to a group now: group-specific prices beat the
 * competition default; among those whose window contains `now`, the most
 * recently started wins (so a dated early-bird beats an open-ended price).
 */
export function resolvePrice(prices: readonly PriceRule[], groupId: string, now: Date): PriceRule | null {
  const t = now.getTime();
  const active = prices.filter((p) => (!p.startsAt || Date.parse(p.startsAt) <= t) && (!p.endsAt || t < Date.parse(p.endsAt)));
  const pick = (list: PriceRule[]) =>
    list.sort((a, b) => (b.startsAt ? Date.parse(b.startsAt) : 0) - (a.startsAt ? Date.parse(a.startsAt) : 0) || a.id.localeCompare(b.id))[0] ?? null;
  return pick(active.filter((p) => p.groupId === groupId)) ?? pick(active.filter((p) => p.groupId === null));
}

export interface OfferCode {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  /** For percent codes; 10000 = 100% (scholarship). */
  percentBps: number | null;
  amountMinor: number | null;
  competitionId: string | null;
  purpose: "promotion" | "scholarship" | "invite" | "trial";
  validFrom: string | null;
  validUntil: string | null;
  maxUses: number | null;
  maxUsesPerUser: number | null;
  status: "active" | "disabled";
}

export type OfferRejection = "DISABLED" | "NOT_STARTED" | "EXPIRED" | "WRONG_COMPETITION" | "USAGE_LIMIT" | "USER_LIMIT";

export function checkOfferCode(
  offer: OfferCode,
  ctx: { competitionId: string; now: Date; usesTotal: number; usesByUser: number; newUses: number },
): OfferRejection | null {
  if (offer.status !== "active") return "DISABLED";
  if (offer.validFrom && ctx.now.getTime() < Date.parse(offer.validFrom)) return "NOT_STARTED";
  if (offer.validUntil && ctx.now.getTime() >= Date.parse(offer.validUntil)) return "EXPIRED";
  if (offer.competitionId && offer.competitionId !== ctx.competitionId) return "WRONG_COMPETITION";
  if (offer.maxUses !== null && ctx.usesTotal + ctx.newUses > offer.maxUses) return "USAGE_LIMIT";
  if (offer.maxUsesPerUser !== null && ctx.usesByUser + ctx.newUses > offer.maxUsesPerUser) return "USER_LIMIT";
  return null;
}

export interface TaxRule {
  rateBps: number;
  /** Prices already include tax (common for HKD/THB consumer pricing) vs tax added on top. */
  inclusive: boolean;
}

export interface LineInput {
  key: string;
  unitAmountMinor: number;
}

export interface LineTotals {
  key: string;
  unitAmountMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface OrderTotals {
  lines: LineTotals[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * Order arithmetic, deterministic to the cent:
 *   price → discount (percent per line, or fixed spread across lines by the
 *   largest-remainder method) → tax (inclusive: extracted; exclusive: added).
 * A 100% scholarship gives a zero total, which needs no payment.
 */
export function computeOrderTotals(lines: readonly LineInput[], offer: Pick<OfferCode, "kind" | "percentBps" | "amountMinor"> | null, tax: TaxRule | null): OrderTotals {
  const subtotal = lines.reduce((s, l) => s + l.unitAmountMinor, 0);
  const discounts = allocateDiscount(lines, offer, subtotal);
  const out: LineTotals[] = lines.map((l, i) => {
    const net = l.unitAmountMinor - discounts[i]!;
    let taxMinor = 0;
    let total = net;
    if (tax && tax.rateBps > 0) {
      if (tax.inclusive) taxMinor = net - Math.floor((net * 10000 + Math.floor((10000 + tax.rateBps) / 2)) / (10000 + tax.rateBps));
      else {
        taxMinor = applyBps(net, tax.rateBps);
        total = net + taxMinor;
      }
    }
    return { key: l.key, unitAmountMinor: l.unitAmountMinor, discountMinor: discounts[i]!, taxMinor, totalMinor: total };
  });
  return {
    lines: out,
    subtotalMinor: subtotal,
    discountMinor: out.reduce((s, l) => s + l.discountMinor, 0),
    taxMinor: out.reduce((s, l) => s + l.taxMinor, 0),
    totalMinor: out.reduce((s, l) => s + l.totalMinor, 0),
  };
}

function allocateDiscount(lines: readonly LineInput[], offer: Pick<OfferCode, "kind" | "percentBps" | "amountMinor"> | null, subtotal: number): number[] {
  if (!offer || subtotal === 0) return lines.map(() => 0);
  if (offer.kind === "percent") return lines.map((l) => Math.min(l.unitAmountMinor, applyBps(l.unitAmountMinor, offer.percentBps ?? 0)));
  const total = Math.min(subtotal, offer.amountMinor ?? 0);
  const raw = lines.map((l) => (total * l.unitAmountMinor) / subtotal);
  const base = raw.map(Math.floor);
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    base[i]! += 1;
    rest -= 1;
  }
  return base;
}
