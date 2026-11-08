import { beforeAll, describe, expect, it } from "vitest";
import type { CompetitionConfig } from "@cos/core";
import { call, createPlatformAdmin, createTenant, deliverWebhook, register, unique, type Session, type TenantFixture, type TestEnv, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let platform: Session;
let A: TenantFixture;

interface Comp {
  id: string;
  groups: Record<string, string>; // key → id
}

/** Create, configure and publish a competition. */
async function competition(t: TenantFixture, opts: {
  feeMode?: "free" | "paid";
  capacity?: number;
  price?: number;
  settings?: Record<string, unknown>;
  visibility?: string;
  contentLocales?: string[];
} = {}): Promise<Comp> {
  const base = `/t/${t.tenantId}/competitions`;
  const created = await call(env.app, t.admin, "POST", base, {
    slug: unique("reg"), name: "Mandarin Cup", feeMode: opts.feeMode ?? "free", ...(opts.visibility && { visibility: opts.visibility }),
    contentLocales: opts.contentLocales ?? ["zh-Hant", "en"],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { competition: c, draft } = created.body;
  const config: CompetitionConfig = draft.config;
  if (opts.capacity !== undefined) config.groups.find((g) => g.key === "primary")!.capacity = opts.capacity;
  await call(env.app, t.admin, "PUT", `${base}/${c.id}/versions/${draft.id}/config`, { revision: 1, config });
  if (opts.feeMode === "paid") {
    const price = await call(env.app, t.admin, "POST", `${base}/${c.id}/prices`, { amountMinor: opts.price ?? 30000 });
    expect(price.status).toBe(201);
  }
  if (opts.settings) expect((await call(env.app, t.admin, "PATCH", `/t/${t.tenantId}/competitions/${c.id}/registration-settings`, opts.settings)).status).toBe(200);
  expect((await call(env.app, t.admin, "POST", `${base}/${c.id}/versions/${draft.id}/publish`, {})).status).toBe(200);
  return { id: c.id, groups: Object.fromEntries(config.groups.map((g) => [g.key, g.id])) };
}

async function parentWithChild(name = "parent", child: Record<string, unknown> = {}) {
  const parent = await register(env.app, name);
  const res = await call(env.app, parent, "POST", "/me/children", { givenName: "Mei", familyName: "Chan", dateOfBirth: "2016-04-01", ...child });
  return { parent, childId: res.body.child.id as string };
}

const consent = { accepted: true, version: "v1" };
const signup = (comp: Comp, childId: string, extra: Record<string, unknown> = {}) => ({
  competitionId: comp.id, studentId: childId, groupId: comp.groups.primary, grade: "P4", contentLocale: "zh-Hant", consent, ...extra,
});

async function pay(e: TestEnv, providerPaymentId: string, amountMinor: number, extra: Record<string, unknown> = {}) {
  return deliverWebhook(e, "payment_intent.succeeded", { id: providerPaymentId, amount: amountMinor / 100, currency: "HKD", ...extra });
}

beforeAll(async () => {
  platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "RegA");
  expect((await call(env.app, platform, "POST", `/platform/tenants/${A.tenantId}/payment-accounts`, { provider: "test", externalAccountId: "acct_rega" })).status).toBe(201);
});

describe("parent registration: free competition", () => {
  it("registers an eligible child, records consent, and connects the child to the organizer", async () => {
    const comp = await competition(A);
    const { parent, childId } = await parentWithChild();

    expect((await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId, { consent: undefined }))).body.error.code).toBe("CONSENT_REQUIRED");
    expect((await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId, { consent: { accepted: true, version: "v0" } }))).body.error.code).toBe("CONSENT_REQUIRED");

    const res = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ registration: { status: "confirmed", channel: "parent", contentLocale: "zh-Hant" }, order: null, payment: null });

    const again = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe("already_registered");

    const { rows } = await env.owner.query("select consent_type, consent_version, granted from consent_records where student_id = $1", [childId]);
    expect(rows).toEqual([{ consent_type: "parent", consent_version: "v1", granted: true }]);

    // The organizer now sees this child, and only through this tenant.
    expect((await call(env.app, A.admin, "GET", `/t/${A.tenantId}/students/${childId}`)).status).toBe(200);
    const list = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/competitions/${comp.id}/registrations`);
    expect(list.body.registrations.map((r: { studentId: string }) => r.studentId)).toEqual([childId]);
    expect((await call(env.app, parent, "GET", "/me/registrations")).body.registrations).toHaveLength(1);
  });

  it("refuses ineligible groups, unoffered languages, closed windows and private competitions", async () => {
    const comp = await competition(A);
    const { parent, childId } = await parentWithChild();
    const ineligible = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId, { groupId: comp.groups.secondary }));
    expect(ineligible.status).toBe(422);
    expect(ineligible.body.error).toMatchObject({ code: "NOT_ELIGIBLE", details: [{ code: "GRADE_TOO_LOW" }] });
    expect((await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId, { contentLocale: "th" }))).status).toBe(400);

    const closed = await competition(A, { settings: { registrationClosesAt: new Date(Date.now() - 60_000).toISOString(), registrationOpensAt: new Date(Date.now() - 3_600_000).toISOString() } });
    const res = await call(env.app, parent, "POST", "/me/registrations", signup(closed, childId));
    expect(res.body.error).toMatchObject({ code: "REGISTRATION_CLOSED", details: { reason: "closed" } });

    const priv = await competition(A, { visibility: "private" });
    expect((await call(env.app, parent, "POST", "/me/registrations", signup(priv, childId))).status).toBe(404);
  });

  it("a parent can only register their own child", async () => {
    const comp = await competition(A);
    const { childId } = await parentWithChild();
    const stranger = await register(env.app, "stranger");
    expect((await call(env.app, stranger, "POST", "/me/registrations", signup(comp, childId))).status).toBe(404);
  });
});

describe("parent registration: paid, through the test gateway", () => {
  it("quotes, holds the seat, takes payment by webhook, and issues a receipt", async () => {
    const comp = await competition(A, { feeMode: "paid", price: 30000 });
    const { parent, childId } = await parentWithChild();

    const quote = await call(env.app, parent, "POST", "/me/registrations/quote", signup(comp, childId));
    expect(quote.body).toMatchObject({ eligible: true, outcome: "pending_payment", currency: "HKD", totals: { totalMinor: 30000 } });

    const res = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    expect(res.status).toBe(201);
    expect(res.body.registration.status).toBe("pending_payment");
    expect(res.body.order).toMatchObject({ status: "pending", paymentMethod: "online", totalMinor: 30000, currency: "HKD" });
    expect(res.body.order.orderNumber).toMatch(/^ORD-\d{4}-\d{6}$/);
    expect(res.body.payment).toMatchObject({ provider: "test", status: "pending", checkout: { kind: "redirect" } });
    const pid = res.body.payment.providerPaymentId;
    expect(env.pay.checkouts.at(-1)).toMatchObject({ merchantAccountId: "acct_rega", amountMinor: 30000, currency: "HKD" });

    // Re-opening checkout reuses the pending payment.
    expect((await call(env.app, parent, "POST", `/me/orders/${res.body.order.id}/checkout`)).body.reused).toBe(true);

    const first = await pay(env, pid, 30000, { fee: 9.3 });
    expect(first.body.outcome).toBe("processed");
    const order = await call(env.app, parent, "GET", `/me/orders/${res.body.order.id}`);
    expect(order.body.order.status).toBe("paid");
    expect(order.body.registrations[0].status).toBe("confirmed");
    expect(order.body.payments[0]).toMatchObject({ status: "succeeded", gatewayFeeMinor: 930 });

    const receipt = await env.app.inject({ method: "GET", url: `/me/orders/${res.body.order.id}/receipt`, headers: { ...parent.headers, "accept-language": "en-HK" } });
    expect(receipt.headers["content-type"]).toContain("text/html");
    expect(receipt.body).toContain(res.body.order.orderNumber);
    expect(receipt.body).toContain("HK$300.00");
  });

  it("webhooks are verified and idempotent", async () => {
    const comp = await competition(A, { feeMode: "paid" });
    const { parent, childId } = await parentWithChild();
    const res = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    const pid = res.body.payment.providerPaymentId;

    expect((await deliverWebhook(env, "payment_intent.succeeded", { id: pid, amount: 300, currency: "HKD" }, { secret: "wrong" })).status).toBe(401);
    expect((await deliverWebhook(env, "payment_intent.succeeded", { id: pid, amount: 300, currency: "HKD" }, { timestamp: Date.now() - 10 * 60_000 })).status).toBe(401);

    const eventId = `evt_${unique("x")}`;
    expect((await pay(env, pid, 30000, { }).then(() => deliverWebhook(env, "payment_intent.succeeded", { id: pid, amount: 300, currency: "HKD" }, { eventId }))).body.outcome).toBe("processed");
    expect((await deliverWebhook(env, "payment_intent.succeeded", { id: pid, amount: 300, currency: "HKD" }, { eventId })).body.outcome).toBe("duplicate");
    expect((await deliverWebhook(env, "payment_intent.succeeded", { id: "test_pi_unknown", amount: 1, currency: "HKD" })).body.outcome).toBe("unknown_reference");
    expect((await deliverWebhook(env, "customer.created", { id: "cus_1" })).body.outcome).toBe("ignored");

    const audits = await env.owner.query("select count(*)::int as n from audit_logs where action = 'payment.succeeded' and target_id = $1", [res.body.order.id]);
    expect(audits.rows[0].n).toBe(1);
  });

  it("does not confirm when the paid amount differs", async () => {
    const comp = await competition(A, { feeMode: "paid" });
    const { parent, childId } = await parentWithChild();
    const res = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    await pay(env, res.body.payment.providerPaymentId, 100);
    const order = await call(env.app, parent, "GET", `/me/orders/${res.body.order.id}`);
    expect(order.body.order.status).toBe("pending");
    expect(order.body.registrations[0]).toMatchObject({ status: "pending_payment", needsAttention: "payment_amount_mismatch" });
  });

  it("keeps the seat when the gateway is down, and lets the parent retry", async () => {
    const comp = await competition(A, { feeMode: "paid" });
    const { parent, childId } = await parentWithChild();
    env.pay.failNext = "checkout";
    const res = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ registration: { status: "pending_payment" }, payment: null });
    const retry = await call(env.app, parent, "POST", `/me/orders/${res.body.order.id}/checkout`);
    expect(retry.body).toMatchObject({ reused: false, payment: { status: "pending" } });
  });
});

describe("offer codes and tax", () => {
  it("applies exclusive tax and percent codes, with usage limits", async () => {
    const tax = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/tax-rates`, { name: "Test VAT", rateBps: 700, inclusive: false });
    const comp = await competition(A, { feeMode: "paid", price: 30000, settings: { taxRateId: tax.body.taxRate.id } });
    const code = unique("HALF").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    expect((await call(env.app, A.admin, "POST", `/t/${A.tenantId}/offer-codes`, { code, competitionId: comp.id, kind: "percent", percentBps: 5000, maxUses: 1 })).status).toBe(201);

    const one = await parentWithChild("p1");
    const quote = await call(env.app, one.parent, "POST", "/me/registrations/quote", signup(comp, one.childId, { offerCode: code.toLowerCase() }));
    expect(quote.body.totals).toMatchObject({ subtotalMinor: 30000, discountMinor: 15000, taxMinor: 1050, totalMinor: 16050 });
    expect((await call(env.app, one.parent, "POST", "/me/registrations", signup(comp, one.childId, { offerCode: code }))).body.order.totalMinor).toBe(16050);

    const two = await parentWithChild("p2");
    const used = await call(env.app, two.parent, "POST", "/me/registrations", signup(comp, two.childId, { offerCode: code }));
    expect(used.body.error).toMatchObject({ code: "OFFER_CODE_INVALID", details: { reason: "USAGE_LIMIT" } });
    expect((await call(env.app, two.parent, "POST", "/me/registrations", signup(comp, two.childId, { offerCode: "NOPE-NOPE" }))).body.error.details.reason).toBe("NOT_FOUND");
    const plain = await call(env.app, two.parent, "POST", "/me/registrations", signup(comp, two.childId));
    expect(plain.body.order.totalMinor).toBe(32100);
  });

  it("a 100% scholarship confirms at once with no payment", async () => {
    const comp = await competition(A, { feeMode: "paid" });
    const code = unique("SCHOLAR").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/offer-codes`, { code, kind: "percent", percentBps: 10000, purpose: "scholarship" });
    const { parent, childId } = await parentWithChild();
    const res = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId, { offerCode: code }));
    expect(res.body).toMatchObject({ registration: { status: "confirmed" }, order: { status: "paid", paymentMethod: "none", totalMinor: 0, discountMinor: 30000 }, payment: null });
  });

  it("invite-only competitions need an invite code", async () => {
    const comp = await competition(A, { visibility: "unlisted", settings: { requiresInviteCode: true } });
    const code = unique("INVITE").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/offer-codes`, { code, competitionId: comp.id, kind: "percent", percentBps: 1, purpose: "invite" });
    const { parent, childId } = await parentWithChild();
    expect((await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId))).body.error.details.reason).toBe("INVITE_REQUIRED");
    expect((await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId, { offerCode: code }))).body.registration.status).toBe("confirmed");
  });
});

describe("capacity, holds and the waitlist", () => {
  it("waitlists when full, releases expired holds, promotes, and flags late payment without a seat", async () => {
    const comp = await competition(A, { feeMode: "paid", capacity: 1 });
    const p1 = await parentWithChild("p1");
    const p2 = await parentWithChild("p2", { givenName: "Kit" });
    const p3 = await parentWithChild("p3", { givenName: "Bo" });

    const r1 = await call(env.app, p1.parent, "POST", "/me/registrations", signup(comp, p1.childId));
    expect(r1.body.registration.status).toBe("pending_payment");
    const r2 = await call(env.app, p2.parent, "POST", "/me/registrations", signup(comp, p2.childId));
    expect(r2.body.registration.status).toBe("waitlisted");
    expect(r2.body.payment).toBeNull();
    expect((await call(env.app, p2.parent, "POST", `/me/orders/${r2.body.order.id}/checkout`)).body.error.details.reason).toBe("nothing_to_pay");

    // p1's hold lapses; the next registration attempt frees the seat and promotes p2.
    await env.owner.query("update registrations set hold_expires_at = now() - interval '1 minute' where id = $1", [r1.body.registration.id]);
    const r3 = await call(env.app, p3.parent, "POST", "/me/registrations", signup(comp, p3.childId));
    expect(r3.body.registration.status).toBe("waitlisted");
    const after = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/competitions/${comp.id}/registrations`);
    const status = Object.fromEntries(after.body.registrations.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(status[r1.body.registration.id]).toBe("cancelled");
    expect(status[r2.body.registration.id]).toBe("pending_payment");

    // p1 pays anyway: money is never lost, but there is no seat — waitlisted and flagged for the organizer.
    await pay(env, r1.body.payment.providerPaymentId, 30000);
    const late = await call(env.app, p1.parent, "GET", `/me/orders/${r1.body.order.id}`);
    expect(late.body.order.status).toBe("paid");
    expect(late.body.registrations[0]).toMatchObject({ status: "waitlisted", needsAttention: "paid_without_seat" });
    const flagged = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/competitions/${comp.id}/registrations?attention=true`);
    expect(flagged.body.registrations.map((r: { id: string }) => r.id)).toEqual([r1.body.registration.id]);
  });

  it("refuses when full and the waitlist is off; parents can withdraw unpaid registrations", async () => {
    const comp = await competition(A, { capacity: 1, settings: { waitlistEnabled: false } });
    const p1 = await parentWithChild("p1");
    const p2 = await parentWithChild("p2", { givenName: "Kit" });
    expect((await call(env.app, p1.parent, "POST", "/me/registrations", signup(comp, p1.childId))).body.registration.status).toBe("confirmed");
    expect((await call(env.app, p2.parent, "POST", "/me/registrations", signup(comp, p2.childId))).body.error.details.reason).toBe("group_full");

    const paidComp = await competition(A, { feeMode: "paid" });
    const reg = await call(env.app, p2.parent, "POST", "/me/registrations", signup(paidComp, p2.childId));
    expect((await call(env.app, p2.parent, "POST", `/me/registrations/${reg.body.registration.id}/cancel`)).status).toBe(200);
    expect((await call(env.app, p2.parent, "GET", `/me/orders/${reg.body.order.id}`)).body.order.status).toBe("cancelled");
    expect((await call(env.app, p1.parent, "POST", `/me/registrations/${(await call(env.app, p1.parent, "GET", "/me/registrations")).body.registrations[0].id}/cancel`)).body.error.details.reason).toBe("contact_organizer");
  });
});

describe("possible duplicates", () => {
  it("flags the same name and date of birth under a different identity, never silently rejecting", async () => {
    const comp = await competition(A);
    const p1 = await parentWithChild("mum", { givenName: "Ada", familyName: "Wong" });
    const p2 = await parentWithChild("dad", { givenName: "ada", familyName: "WONG" });
    await call(env.app, p1.parent, "POST", "/me/registrations", signup(comp, p1.childId));
    const second = await call(env.app, p2.parent, "POST", "/me/registrations", signup(comp, p2.childId));
    expect(second.body.registration).toMatchObject({ status: "confirmed", needsAttention: "possible_duplicate" });
    expect(second.body.registration.possibleDuplicateOf).toBeTruthy();

    const url = `/t/${A.tenantId}/registrations/${second.body.registration.id}/duplicate`;
    expect((await call(env.app, A.admin, "POST", url, { resolution: "not_duplicate" })).status).toBe(400);
    const resolved = await call(env.app, A.admin, "POST", url, { resolution: "not_duplicate", reason: "Twins checked by phone" });
    expect(resolved.body.registration).toMatchObject({ duplicateResolution: "not_duplicate", needsAttention: null, status: "confirmed" });
  });
});

describe("refunds", () => {
  it("refunds through the gateway, cancels the registration and settles by webhook", async () => {
    const comp = await competition(A, { feeMode: "paid", capacity: 1 });
    const p1 = await parentWithChild("p1");
    const p2 = await parentWithChild("p2", { givenName: "Kit" });
    const r1 = await call(env.app, p1.parent, "POST", "/me/registrations", signup(comp, p1.childId));
    await pay(env, r1.body.payment.providerPaymentId, 30000);
    const r2 = await call(env.app, p2.parent, "POST", "/me/registrations", signup(comp, p2.childId));
    expect(r2.body.registration.status).toBe("waitlisted");

    const url = `/t/${A.tenantId}/orders/${r1.body.order.id}/refunds`;
    expect((await call(env.app, A.admin, "POST", url, { amountMinor: 999999, reason: "Too much" })).status).toBe(400);
    const res = await call(env.app, A.admin, "POST", url, { registrationIds: [r1.body.registration.id], amountMinor: 20000, reason: "Withdrew; cancellation fee kept" });
    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ status: "pending", amountMinor: 20000 });
    expect(env.pay.refunds.at(-1)).toMatchObject({ providerPaymentId: r1.body.payment.providerPaymentId, amountMinor: 20000, merchantAccountId: "acct_rega" });

    // The freed seat goes to the waitlist at once.
    const regs = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/competitions/${comp.id}/registrations`);
    const byId = Object.fromEntries(regs.body.registrations.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId).toMatchObject({ [r1.body.registration.id]: "cancelled", [r2.body.registration.id]: "pending_payment" });

    await deliverWebhook(env, "refund.settled", { id: res.body.refund.providerRefundId, payment_intent_id: r1.body.payment.providerPaymentId, amount: 200, currency: "HKD" });
    const order = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/orders/${r1.body.order.id}`);
    expect(order.body.order).toMatchObject({ status: "partially_refunded", refundedMinor: 20000 });
    expect(order.body.refunds[0].status).toBe("succeeded");
    expect(order.body.economics).toMatchObject({ grossMinor: 30000, refundedMinor: 20000 });

    const rest = await call(env.app, A.admin, "POST", url, { reason: "Full refund of the rest" });
    expect(rest.body.refund.amountMinor).toBe(10000);
  });

  it("marks the refund failed when the gateway refuses", async () => {
    const comp = await competition(A, { feeMode: "paid" });
    const { parent, childId } = await parentWithChild();
    const r = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    await pay(env, r.body.payment.providerPaymentId, 30000);
    env.pay.failNext = "refund";
    const res = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/orders/${r.body.order.id}/refunds`, { reason: "Duplicate payment" });
    expect(res.status).toBe(503);
    const order = await call(env.app, A.admin, "GET", `/t/${A.tenantId}/orders/${r.body.order.id}`);
    expect(order.body.refunds[0].status).toBe("failed");
    expect(order.body.order.status).toBe("paid");
    // The failed amount is refundable again.
    expect((await call(env.app, A.admin, "POST", `/t/${A.tenantId}/orders/${r.body.order.id}/refunds`, { reason: "Retry" })).body.refund.amountMinor).toBe(30000);
  });
});

describe("school bulk registration", () => {
  it("previews, requires consent attestation, invoices, and is marked paid", async () => {
    const comp = await competition(A, { feeMode: "paid", price: 20000 });
    const school = (await call(env.app, A.admin, "POST", `/t/${A.tenantId}/schools`, { name: "Sunny Primary" })).body.school.id;
    const roster = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/schools/${school}/students`, {
      students: [
        { givenName: "Amy", familyName: "Lau", dateOfBirth: "2016-02-02", grade: "P4" },
        { givenName: "Ben", familyName: "Lau", dateOfBirth: "2016-03-03", grade: "P4" },
        { givenName: "Cat", familyName: "Ho", dateOfBirth: "2021-01-01", grade: "K2" },
      ],
    });
    const [amy, ben, cat] = roster.body.created.map((c: { studentId: string }) => c.studentId);
    const schoolAdmin = await register(env.app, "school-admin");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: schoolAdmin.email, role: "school_admin", schoolId: school });
    const url = `/t/${A.tenantId}/competitions/${comp.id}/school-registrations`;
    const entries = [{ studentId: amy, groupId: comp.groups.primary }, { studentId: ben, groupId: comp.groups.primary }, { studentId: cat, groupId: comp.groups.primary }];

    const preview = await call(env.app, schoolAdmin, "POST", url, { schoolId: school, entries, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.problems).toEqual([{ index: 2, studentId: cat, code: "NOT_ELIGIBLE", detail: [expect.objectContaining({ code: "GRADE_TOO_LOW" })] }]);
    expect(preview.body.totals.totalMinor).toBe(40000);

    expect((await call(env.app, schoolAdmin, "POST", url, { schoolId: school, entries: entries.slice(0, 2) })).body.error.code).toBe("CONSENT_REQUIRED");
    const res = await call(env.app, schoolAdmin, "POST", url, { schoolId: school, entries: entries.slice(0, 2), consentAttestation: true, paymentMethod: "invoice" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.registrations.map((r: { status: string; channel: string }) => `${r.channel}:${r.status}`)).toEqual(["school:confirmed", "school:confirmed"]);
    expect(res.body.order).toMatchObject({ kind: "school", paymentMethod: "invoice", status: "pending", totalMinor: 40000 });

    const invoice = await env.app.inject({ method: "GET", url: `/t/${A.tenantId}/orders/${res.body.order.id}/receipt`, headers: A.admin.headers });
    expect(invoice.body).toContain("Invoice");
    expect(invoice.body).toContain("Sunny Primary");

    const paid = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/orders/${res.body.order.id}/mark-paid`, { reference: "BANK-TT-8812", reason: "Bank transfer received" });
    expect(paid.body.order).toMatchObject({ status: "paid", externalReference: "BANK-TT-8812" });

    // Another school's admin cannot submit for this school.
    const other = await register(env.app, "other-sa");
    const otherSchool = (await call(env.app, A.admin, "POST", `/t/${A.tenantId}/schools`, { name: "Other" })).body.school.id;
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: other.email, role: "school_admin", schoolId: otherSchool });
    expect((await call(env.app, other, "POST", url, { schoolId: school, entries, dryRun: true })).status).toBe(403);
    // Students not on the roster are reported.
    const notOnRoster = await call(env.app, schoolAdmin, "POST", url, { schoolId: school, entries: [{ studentId: crypto.randomUUID(), groupId: comp.groups.primary }], dryRun: true });
    expect(notOnRoster.body.problems[0].code).toBe("STUDENT_NOT_FOUND");
  });
});

describe("reconciliation and economics", () => {
  it("matches gateway transactions and reports tenant net after fees", async () => {
    const t = await createTenant(env, platform, "Recon");
    await call(env.app, platform, "POST", `/platform/tenants/${t.tenantId}/payment-accounts`, { provider: "test", externalAccountId: "acct_recon" });
    await call(env.app, platform, "POST", `/platform/tenants/${t.tenantId}/platform-fee`, { bps: 500, reason: "Starter plan 5%" });
    const comp = await competition(t, { feeMode: "paid", price: 30000 });
    const pids: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const { parent, childId } = await parentWithChild(name, { givenName: name });
      const r = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
      await pay(env, r.body.payment.providerPaymentId, 30000, { fee: 9 });
      pids.push(r.body.payment.providerPaymentId);
    }
    const settled = new Date().toISOString();
    const imp = await call(env.app, t.admin, "POST", `/t/${t.tenantId}/payments/gateway-transactions`, {
      provider: "test",
      transactions: [
        { providerTxnId: "tx1", kind: "payment", providerRef: pids[0], amountMinor: 30000, feeMinor: 900, currency: "HKD", settledAt: settled },
        { providerTxnId: "tx2", kind: "payment", providerRef: pids[1], amountMinor: 29000, feeMinor: 900, currency: "HKD", settledAt: settled },
        { providerTxnId: "tx9", kind: "payment", providerRef: "test_pi_ghost", amountMinor: 5000, feeMinor: 150, currency: "HKD", settledAt: settled },
      ],
    });
    expect(imp.body).toEqual({ received: 3, imported: 3 });
    expect((await call(env.app, t.admin, "POST", `/t/${t.tenantId}/payments/gateway-transactions`, { provider: "test", transactions: [{ providerTxnId: "tx1", kind: "payment", providerRef: pids[0], amountMinor: 30000, currency: "HKD", settledAt: settled }] })).body.imported).toBe(0);

    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const rec = await call(env.app, t.admin, "GET", `/t/${t.tenantId}/payments/reconciliation?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(rec.body.counts).toEqual({ matched: 1, unsettled: 1, mismatch: 2 });
    expect(rec.body.rows.find((r: { providerRef: string }) => r.providerRef === pids[1]).reason).toBe("amount_differs");

    const summary = await call(env.app, t.admin, "GET", `/t/${t.tenantId}/payments/summary?competitionId=${comp.id}`);
    expect(summary.body.currencies).toEqual([{ currency: "HKD", grossMinor: 90000, gatewayFeeMinor: 2700, platformFeeMinor: 4500, refundedMinor: 0, orders: 3, tenantNetMinor: 82800 }]);
  });
});

describe("isolation", () => {
  it("other tenants and other parents cannot see orders", async () => {
    const B = await createTenant(env, platform, "RegB");
    const comp = await competition(A, { feeMode: "paid" });
    const { parent, childId } = await parentWithChild();
    const r = await call(env.app, parent, "POST", "/me/registrations", signup(comp, childId));
    expect((await call(env.app, B.admin, "GET", `/t/${B.tenantId}/orders/${r.body.order.id}`)).status).toBe(404);
    expect((await call(env.app, B.admin, "GET", `/t/${A.tenantId}/orders`)).status).toBe(404);
    const other = await register(env.app, "other");
    expect((await call(env.app, other, "GET", `/me/orders/${r.body.order.id}`)).status).toBe(404);
    expect((await call(env.app, other, "GET", "/me/orders")).body.orders).toEqual([]);
    const judge = await register(env.app, "judge");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: judge.email, role: "judge" });
    expect((await call(env.app, judge, "GET", `/t/${A.tenantId}/orders`)).status).toBe(403);
  });
});
