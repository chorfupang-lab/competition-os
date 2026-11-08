import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import { AppError } from "@cos/core";
import { SYSTEM_PLATFORM, systemTenantContext, withContext, type DB, type DbContext, type Order, type Tx } from "@cos/db";
import type { PaymentEvent, PaymentProvider, PaymentProviders, ProviderName } from "../payments/index.ts";
import { audit } from "./audit.ts";
import { newId } from "./crypto.ts";

export async function paymentAccount(tx: Tx, tenantId: string): Promise<{ provider: ProviderName | null; externalAccountId: string | null; platformFeeBps: number }> {
  const { rows } = await sql<{ provider: ProviderName | null; external_account_id: string | null; platform_fee_bps: number }>`
    select * from app.tenant_payment_account(${tenantId})`.execute(tx);
  const r = rows[0];
  return { provider: r?.provider ?? null, externalAccountId: r?.external_account_id ?? null, platformFeeBps: r?.platform_fee_bps ?? 0 };
}

export function providerFor(providers: PaymentProviders, name: ProviderName | null): PaymentProvider {
  const p = name ? providers.get(name) : undefined;
  if (!p) throw new AppError("PAYMENT_UNAVAILABLE", { reason: name ? "provider_not_configured" : "tenant_has_no_payment_account" });
  return p;
}

/**
 * Open (or re-open) hosted checkout for an order. The provider call happens
 * outside any database transaction, so no locks are held while we wait on
 * the network; an existing recent pending payment is reused.
 */
export async function startCheckout(db: DB, providers: PaymentProviders, request: FastifyRequest, ctx: DbContext, orderId: string, appUrl: string) {
  const prep = await withContext(db, ctx, async (tx) => {
    const order = await tx.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
    if (!order) throw new AppError("NOT_FOUND");
    if (order.status !== "pending" || order.payment_method !== "online") throw new AppError("CONFLICT", { reason: "order_not_payable", status: order.status });
    const payable = await tx.selectFrom("registrations").select("id").where("order_id", "=", orderId).where("status", "=", "pending_payment").executeTakeFirst();
    if (!payable) throw new AppError("CONFLICT", { reason: "nothing_to_pay", hint: "waitlisted registrations can be paid once a seat is offered" });
    const recent = await tx
      .selectFrom("payments")
      .selectAll()
      .where("order_id", "=", orderId)
      .where("status", "=", "pending")
      .where("created_at", ">", new Date(Date.now() - 30 * 60_000))
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    const account = await paymentAccount(tx, order.tenant_id);
    const attempts = await tx.selectFrom("payments").select((eb) => eb.fn.countAll<string>().as("n")).where("order_id", "=", orderId).executeTakeFirstOrThrow();
    return { order: order as Order, recent, account, attempt: Number(attempts.n) + 1 };
  });
  if (prep.recent) return { payment: prep.recent, reused: true };

  const provider = providerFor(providers, prep.account.provider);
  let result;
  try {
    result = await provider.createCheckout({
      merchantAccountId: prep.account.externalAccountId!,
      orderId: prep.order.id,
      orderNumber: prep.order.order_number,
      idempotencyKey: `${prep.order.id}:${prep.attempt}`,
      amountMinor: Number(prep.order.total_minor),
      currency: prep.order.currency,
      description: prep.order.order_number,
      returnUrl: `${appUrl}/orders/${prep.order.id}/return`,
      metadata: { order_id: prep.order.id, tenant_id: prep.order.tenant_id, order_number: prep.order.order_number },
    });
  } catch (err) {
    request.log.warn({ err, orderId }, "checkout creation failed");
    throw new AppError("PAYMENT_UNAVAILABLE", { reason: "provider_error" });
  }
  const payment = await withContext(db, ctx, async (tx) => {
    const id = newId();
    await tx
      .insertInto("payments")
      .values({
        id,
        tenant_id: prep.order.tenant_id,
        order_id: prep.order.id,
        provider: provider.name,
        provider_payment_id: result.providerPaymentId,
        status: "pending",
        amount_minor: Number(prep.order.total_minor),
        currency: prep.order.currency,
        checkout: JSON.stringify(result.checkout),
        failure_code: null,
        succeeded_at: null,
      })
      .execute();
    await audit(tx, request, {
      tenantId: prep.order.tenant_id,
      actorUserId: ctx.userId,
      action: "payment.checkout_started",
      targetType: "order",
      targetId: prep.order.id,
      after: { provider: provider.name, providerPaymentId: result.providerPaymentId, amountMinor: Number(prep.order.total_minor), currency: prep.order.currency },
    });
    return tx.selectFrom("payments").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  });
  return { payment, reused: false };
}

// ---------------------------------------------------------------- webhooks

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "unknown_reference";

/**
 * Record a verified webhook once (idempotent on provider + event id), then
 * apply it inside the owning tenant as the system actor.
 */
export async function handlePaymentEvent(db: DB, request: FastifyRequest, provider: ProviderName, event: PaymentEvent): Promise<WebhookOutcome> {
  const fresh = await withContext(db, SYSTEM_PLATFORM, async (tx) => {
    const inserted = await tx
      .insertInto("webhook_events")
      .values({ provider, event_id: event.eventId, event_type: event.rawType, tenant_id: null, payload: JSON.stringify(event), processing_error: null })
      .onConflict((oc) => oc.columns(["provider", "event_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) return inserted.id;
    const prior = await tx.selectFrom("webhook_events").select(["id", "processed_at"]).where("provider", "=", provider).where("event_id", "=", event.eventId).executeTakeFirstOrThrow();
    return prior.processed_at ? null : prior.id; // retry of a delivery we failed to process
  });
  if (!fresh) return "duplicate";

  const finish = (tenantId: string | null, error: string | null) =>
    withContext(db, SYSTEM_PLATFORM, (tx) =>
      tx.updateTable("webhook_events").set({ processed_at: new Date(), tenant_id: tenantId, processing_error: error }).where("id", "=", fresh).execute(),
    );

  if (event.type === "ignored") {
    await finish(null, null);
    return "ignored";
  }
  const tenantId = await withContext(db, SYSTEM_PLATFORM, async (tx) => {
    if (event.type.startsWith("refund.") && event.providerRefundId) {
      const { rows } = await sql<{ t: string | null }>`select app.refund_tenant(${event.providerRefundId}) as t`.execute(tx);
      if (rows[0]?.t) return rows[0].t;
    }
    if (!event.providerPaymentId) return null;
    const { rows } = await sql<{ t: string | null }>`select app.payment_tenant(${provider}, ${event.providerPaymentId}) as t`.execute(tx);
    return rows[0]?.t ?? null;
  });
  if (!tenantId) {
    await finish(null, "unknown_reference");
    return "unknown_reference";
  }
  await withContext(db, systemTenantContext(tenantId), (tx) => applyEvent(tx, request, provider, event, tenantId));
  await finish(tenantId, null);
  return "processed";
}

async function applyEvent(tx: Tx, request: FastifyRequest, provider: ProviderName, event: PaymentEvent, tenantId: string): Promise<void> {
  const now = new Date();
  const meta = { via: "webhook", provider, eventId: event.eventId };

  if (event.type.startsWith("payment.")) {
    const payment = await tx.selectFrom("payments").selectAll().where("provider", "=", provider).where("provider_payment_id", "=", event.providerPaymentId!).forUpdate().executeTakeFirstOrThrow();
    if (payment.status === "succeeded") return; // already final
    if (event.type === "payment.failed" || event.type === "payment.cancelled") {
      await tx.updateTable("payments").set({ status: event.type === "payment.failed" ? "failed" : "cancelled", failure_code: event.failureCode ?? null }).where("id", "=", payment.id).execute();
      await audit(tx, request, { tenantId, actorUserId: null, action: event.type === "payment.failed" ? "payment.failed" : "payment.cancelled", targetType: "order", targetId: payment.order_id, after: { failureCode: event.failureCode ?? null }, metadata: meta });
      return;
    }
    // payment.succeeded
    const amountOk = event.amountMinor === undefined || event.amountMinor === Number(payment.amount_minor);
    const currencyOk = !event.currency || event.currency === payment.currency;
    if (!amountOk || !currencyOk) {
      await tx.updateTable("registrations").set({ needs_attention: "payment_amount_mismatch" }).where("order_id", "=", payment.order_id).execute();
      await audit(tx, request, { tenantId, actorUserId: null, action: "payment.amount_mismatch", targetType: "order", targetId: payment.order_id, after: { expected: { amountMinor: Number(payment.amount_minor), currency: payment.currency }, received: { amountMinor: event.amountMinor, currency: event.currency } }, metadata: meta });
      return;
    }
    await tx.updateTable("payments").set({ status: "succeeded", succeeded_at: now, gateway_fee_minor: event.feeMinor ?? null }).where("id", "=", payment.id).execute();
    const order = await tx.selectFrom("orders").selectAll().where("id", "=", payment.order_id).forUpdate().executeTakeFirstOrThrow();
    await tx.updateTable("orders").set({ status: "paid", paid_at: now, expires_at: null }).where("id", "=", order.id).execute();
    await tx.updateTable("offer_code_redemptions").set({ status: "active" }).where("order_id", "=", order.id).execute();

    const regs = await tx.selectFrom("registrations").selectAll().where("order_id", "=", order.id).execute();
    const comp = await tx.selectFrom("competitions as c").innerJoin("competition_versions as v", "v.id", "c.current_version_id").select(["v.config"]).where("c.id", "=", order.competition_id).executeTakeFirstOrThrow();
    const capacity = new Map(((comp.config as { groups: Array<{ id: string; capacity: number | null }> }).groups).map((g) => [g.id, g.capacity ?? null]));
    for (const r of regs) {
      if (r.status === "pending_payment") {
        await tx.updateTable("registrations").set({ status: "confirmed", confirmed_at: now, hold_expires_at: null }).where("id", "=", r.id).execute();
      } else if (r.status === "cancelled" && r.cancel_reason === "payment_hold_expired") {
        // Paid after the hold lapsed: confirm if a seat is still free, otherwise waitlist and flag for the organizer.
        const cap = capacity.get(r.group_id) ?? null;
        const { rows } = await sql<{ n: number }>`select app.group_seats_taken(${r.competition_id}, ${r.group_id}) as n`.execute(tx);
        const seat = cap === null || rows[0]!.n < cap;
        await tx
          .updateTable("registrations")
          .set(seat
            ? { status: "confirmed", confirmed_at: now, cancelled_at: null, cancel_reason: null, hold_expires_at: null }
            : { status: "waitlisted", waitlisted_at: now, cancelled_at: null, cancel_reason: null, needs_attention: "paid_without_seat" })
          .where("id", "=", r.id)
          .execute();
      }
    }
    await audit(tx, request, { tenantId, actorUserId: null, action: "payment.succeeded", targetType: "order", targetId: order.id, after: { amountMinor: Number(payment.amount_minor), currency: payment.currency, feeMinor: event.feeMinor ?? null }, metadata: meta });
    return;
  }

  // refund.*
  const refund = await tx.selectFrom("refunds").selectAll().where("provider_refund_id", "=", event.providerRefundId!).forUpdate().executeTakeFirst();
  if (!refund || refund.status !== "pending") return;
  if (event.type === "refund.failed") {
    await tx.updateTable("refunds").set({ status: "failed", completed_at: now }).where("id", "=", refund.id).execute();
    await audit(tx, request, { tenantId, actorUserId: null, action: "refund.failed", targetType: "order", targetId: refund.order_id, after: { refundId: refund.id }, metadata: meta });
    return;
  }
  await completeRefund(tx, request, refund.id, now, meta);
}

export async function completeRefund(tx: Tx, request: FastifyRequest | null, refundId: string, now: Date, meta: Record<string, unknown>): Promise<void> {
  const refund = await tx.updateTable("refunds").set({ status: "succeeded", completed_at: now }).where("id", "=", refundId).returningAll().executeTakeFirstOrThrow();
  const order = await tx.selectFrom("orders").selectAll().where("id", "=", refund.order_id).forUpdate().executeTakeFirstOrThrow();
  const refunded = Number(order.refunded_minor) + Number(refund.amount_minor);
  await tx
    .updateTable("orders")
    .set({ refunded_minor: refunded, status: refunded >= Number(order.total_minor) ? "refunded" : "partially_refunded" })
    .where("id", "=", order.id)
    .execute();
  await audit(tx, request, { tenantId: order.tenant_id, actorUserId: null, action: "refund.succeeded", targetType: "order", targetId: order.id, after: { refundId, amountMinor: Number(refund.amount_minor), refundedTotalMinor: refunded }, metadata: meta });
}
