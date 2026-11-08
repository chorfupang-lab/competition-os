import { describe, expect, it } from "vitest";
import {
  applyBps,
  checkOfferCode,
  computeOrderTotals,
  decimalToMinor,
  formatMoney,
  minorToDecimal,
  reconcile,
  resolvePrice,
  tenantNet,
  type OfferCode,
} from "./index.ts";

describe("money", () => {
  it("converts minor units both ways", () => {
    expect(minorToDecimal(12345, "HKD")).toBe("123.45");
    expect(minorToDecimal(5, "USD")).toBe("0.05");
    expect(minorToDecimal(1500, "JPY")).toBe("1500");
    expect(decimalToMinor("123.4", "HKD")).toBe(12340);
    expect(decimalToMinor("99.99", "THB")).toBe(9999);
    expect(decimalToMinor(1500, "JPY")).toBe(1500);
  });

  it("rounds basis points half up", () => {
    expect(applyBps(1000, 750)).toBe(75);
    expect(applyBps(15, 5000)).toBe(8);
  });

  it("formats in the viewer's locale", () => {
    expect(formatMoney(12345, "HKD", "en-HK")).toBe("HK$123.45");
    expect(formatMoney(50000, "THB", "th-TH")).toContain("500.00");
  });
});

describe("pricing", () => {
  const g = "group-1";
  const prices = [
    { id: "default", groupId: null, amountMinor: 30000, startsAt: null, endsAt: null },
    { id: "primary", groupId: g, amountMinor: 25000, startsAt: null, endsAt: null },
    { id: "early", groupId: g, amountMinor: 20000, startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-02-01T00:00:00Z" },
  ];
  it("prefers the group price, then the dated window", () => {
    expect(resolvePrice(prices, g, new Date("2026-01-15T00:00:00Z"))!.id).toBe("early");
    expect(resolvePrice(prices, g, new Date("2026-03-01T00:00:00Z"))!.id).toBe("primary");
    expect(resolvePrice(prices, "other", new Date("2026-03-01T00:00:00Z"))!.id).toBe("default");
    expect(resolvePrice([], g, new Date())).toBeNull();
  });
});

describe("offer codes", () => {
  const offer: OfferCode = {
    id: "o", code: "XMAS", kind: "percent", percentBps: 2000, amountMinor: null, competitionId: "c1", purpose: "promotion",
    validFrom: "2026-12-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z", maxUses: 10, maxUsesPerUser: 1, status: "active",
  };
  const ctx = { competitionId: "c1", now: new Date("2026-12-10T00:00:00Z"), usesTotal: 0, usesByUser: 0, newUses: 1 };
  it("checks status, window, competition and limits", () => {
    expect(checkOfferCode(offer, ctx)).toBeNull();
    expect(checkOfferCode({ ...offer, status: "disabled" }, ctx)).toBe("DISABLED");
    expect(checkOfferCode(offer, { ...ctx, now: new Date("2026-11-30T00:00:00Z") })).toBe("NOT_STARTED");
    expect(checkOfferCode(offer, { ...ctx, now: new Date("2027-01-01T00:00:00Z") })).toBe("EXPIRED");
    expect(checkOfferCode(offer, { ...ctx, competitionId: "c2" })).toBe("WRONG_COMPETITION");
    expect(checkOfferCode(offer, { ...ctx, usesTotal: 10 })).toBe("USAGE_LIMIT");
    expect(checkOfferCode(offer, { ...ctx, usesByUser: 1 })).toBe("USER_LIMIT");
    expect(checkOfferCode({ ...offer, maxUsesPerUser: null }, { ...ctx, newUses: 11 })).toBe("USAGE_LIMIT");
  });
});

describe("order totals", () => {
  const lines = [{ key: "a", unitAmountMinor: 10000 }, { key: "b", unitAmountMinor: 10000 }, { key: "c", unitAmountMinor: 10000 }];

  it("applies a percent discount per line and exclusive tax on top", () => {
    const t = computeOrderTotals(lines, { kind: "percent", percentBps: 1000, amountMinor: null }, { rateBps: 700, inclusive: false });
    expect(t).toMatchObject({ subtotalMinor: 30000, discountMinor: 3000, taxMinor: 1890, totalMinor: 28890 });
  });

  it("spreads a fixed discount exactly across lines", () => {
    const t = computeOrderTotals(lines, { kind: "fixed", percentBps: null, amountMinor: 10000 }, null);
    expect(t.lines.map((l) => l.discountMinor)).toEqual([3334, 3333, 3333]);
    expect(t.totalMinor).toBe(20000);
  });

  it("extracts inclusive tax without changing the total", () => {
    const t = computeOrderTotals([{ key: "a", unitAmountMinor: 10700 }], null, { rateBps: 700, inclusive: true });
    expect(t).toMatchObject({ totalMinor: 10700, taxMinor: 700 });
  });

  it("a 100% scholarship is free and never negative", () => {
    expect(computeOrderTotals(lines, { kind: "percent", percentBps: 10000, amountMinor: null }, { rateBps: 700, inclusive: false }).totalMinor).toBe(0);
    expect(computeOrderTotals(lines, { kind: "fixed", percentBps: null, amountMinor: 999999 }, null).totalMinor).toBe(0);
  });
});

describe("reconciliation", () => {
  it("classifies matched, unsettled and mismatched transactions", () => {
    const rows = reconcile(
      [
        { kind: "payment", providerRef: "p1", orderId: "o1", amountMinor: 1000, currency: "HKD" },
        { kind: "payment", providerRef: "p2", orderId: "o2", amountMinor: 1000, currency: "HKD" },
        { kind: "payment", providerRef: "p3", orderId: "o3", amountMinor: 1000, currency: "HKD" },
        { kind: "refund", providerRef: "r1", orderId: "o1", amountMinor: 500, currency: "HKD" },
      ],
      [
        { kind: "payment", providerRef: "p1", amountMinor: 1000, feeMinor: 30, currency: "HKD", settledAt: "2026-12-02" },
        { kind: "payment", providerRef: "p3", amountMinor: 900, feeMinor: 27, currency: "HKD", settledAt: "2026-12-02" },
        { kind: "refund", providerRef: "r1", amountMinor: 500, feeMinor: 0, currency: "HKD", settledAt: "2026-12-03" },
        { kind: "payment", providerRef: "ghost", amountMinor: 700, feeMinor: 21, currency: "HKD", settledAt: "2026-12-03" },
      ],
    );
    expect(rows.map((r) => `${r.providerRef}:${r.status}${r.reason ? `:${r.reason}` : ""}`)).toEqual([
      "p1:matched", "p2:unsettled", "p3:mismatch:amount_differs", "r1:matched", "ghost:mismatch:no_system_record",
    ]);
  });

  it("computes tenant net", () => {
    expect(tenantNet({ grossMinor: 10000, gatewayFeeMinor: 300, platformFeeMinor: 500, refundedMinor: 1000 })).toBe(8200);
  });
});
