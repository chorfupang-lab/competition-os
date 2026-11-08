import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError } from "@cos/core";
import { ANONYMOUS, systemTenantContext, withContext, type DbContext, type Order } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { requireAuth, type AuthInfo } from "../lib/auth.ts";
import { paymentAccount, providerFor, startCheckout } from "../lib/payments.ts";
import { presentOrder, presentPayment, presentRefund, presentRegistration } from "../lib/present-commerce.ts";
import { renderReceipt } from "../lib/receipt.ts";
import {
  cancelOrderIfEmpty,
  checkRegistrationOpen,
  createRegistrations,
  loadCompetitionForRegistration,
  planRegistrations,
  releaseAndPromote,
  type PlanOptions,
} from "../lib/registration.ts";
import { parse, zLocale, zUuid } from "../lib/validation.ts";

const RegisterBody = z.object({
  competitionId: zUuid,
  studentId: zUuid,
  groupId: zUuid,
  /** The child's current grade, as the parent states it (e.g. P4, 小四, ป.4). */
  grade: z.string().trim().min(1).max(40).optional(),
  contentLocale: zLocale,
  offerCode: z.string().trim().min(3).max(40).optional(),
  consent: z.object({ accepted: z.literal(true), version: z.string().min(1).max(40) }).optional(),
});
const QuoteBody = RegisterBody.omit({ consent: true });

const personal = (auth: AuthInfo): DbContext => ({ ...ANONYMOUS, userId: auth.userId });

/**
 * The parent flow:
 *   Select child → Competition → Group eligibility → Language → Consent → Offer code → Checkout → Receipt
 */
export async function meRegistrationRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, providers } = app.deps;

  async function plan(auth: AuthInfo, body: z.infer<typeof QuoteBody>, now: Date) {
    return withContext(db, personal(auth), async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`competition:${body.competitionId}`}))`.execute(tx);
      const competition = await loadCompetitionForRegistration(tx, body.competitionId);
      checkRegistrationOpen(competition, "parent", now);
      const child = await tx
        .selectFrom("parent_children as pc")
        .innerJoin("students as s", "s.id", "pc.student_id")
        .select(["s.id", "s.date_of_birth", "s.given_name", "s.family_name"])
        .where("pc.parent_user_id", "=", auth.userId)
        .where("pc.student_id", "=", body.studentId)
        .executeTakeFirst();
      if (!child) throw new AppError("NOT_FOUND", { field: "studentId" });
      const options: PlanOptions = {
        competition,
        entries: [{ studentId: body.studentId, groupId: body.groupId, grade: body.grade ?? null, contentLocale: body.contentLocale, schoolId: null }],
        students: new Map([[child.id, child]]),
        buyerUserId: auth.userId,
        offerCode: body.offerCode ?? null,
        channel: "parent",
        paymentMethod: "online",
        now,
      };
      return { competition, plan: await planRegistrations(tx, options) };
    });
  }

  const raise = (problems: Array<{ code: string; detail?: unknown }>) => {
    const p = problems[0]!;
    if (p.code === "NOT_ELIGIBLE") throw new AppError("NOT_ELIGIBLE", p.detail);
    if (p.code === "ALREADY_REGISTERED") throw new AppError("CONFLICT", { reason: "already_registered", ...(p.detail as object) });
    if (p.code === "GROUP_FULL") throw new AppError("CONFLICT", { reason: "group_full" });
    throw new AppError("VALIDATION_FAILED", [{ path: "groupId", message: p.code }]);
  };

  /** Price, seat and eligibility check before committing. Writes nothing. */
  app.post("/registrations/quote", async (request) => {
    const auth = requireAuth(request);
    const body = parse(QuoteBody, request.body);
    const { plan: p, competition } = await plan(auth, body, new Date());
    if (p.problems.length) raise(p.problems);
    const entry = p.entries[0]!;
    return {
      eligible: true,
      eligibility: entry.eligibility,
      outcome: entry.status, // confirmed | pending_payment | waitlisted
      possibleDuplicate: entry.possibleDuplicateOf !== null,
      currency: competition.currency,
      totals: p.totals,
      offerCode: p.offer ? { code: p.offer.code, purpose: p.offer.purpose } : null,
      consent: { required: competition.consent_required, version: competition.consent_version, text: competition.consent_text_i18n },
    };
  });

  app.post("/registrations", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parse(RegisterBody, request.body);
    const now = new Date();
    // Free expired holds first, so a released seat can be taken.
    const preview = await withContext(db, personal(auth), (tx) => loadCompetitionForRegistration(tx, body.competitionId));
    await releaseAndPromote(db, request, preview.id, preview.tenant_id, now);

    const result = await withContext(db, personal(auth), async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`competition:${body.competitionId}`}))`.execute(tx);
      const competition = await loadCompetitionForRegistration(tx, body.competitionId);
      checkRegistrationOpen(competition, "parent", now);
      if (competition.consent_required) {
        if (!body.consent) throw new AppError("CONSENT_REQUIRED", { version: competition.consent_version });
        if (body.consent.version !== competition.consent_version) throw new AppError("CONSENT_REQUIRED", { reason: "version_changed", version: competition.consent_version });
      }
      const child = await tx
        .selectFrom("parent_children as pc")
        .innerJoin("students as s", "s.id", "pc.student_id")
        .select(["s.id", "s.date_of_birth", "s.given_name", "s.family_name"])
        .where("pc.parent_user_id", "=", auth.userId)
        .where("pc.student_id", "=", body.studentId)
        .executeTakeFirst();
      if (!child) throw new AppError("NOT_FOUND", { field: "studentId" });
      const options: PlanOptions = {
        competition,
        entries: [{ studentId: body.studentId, groupId: body.groupId, grade: body.grade ?? null, contentLocale: body.contentLocale, schoolId: null }],
        students: new Map([[child.id, child]]),
        buyerUserId: auth.userId,
        offerCode: body.offerCode ?? null,
        channel: "parent",
        paymentMethod: "online",
        now,
      };
      const p = await planRegistrations(tx, options);
      if (p.problems.length) raise(p.problems);
      const account = await paymentAccount(tx, competition.tenant_id);
      // Fail before writing anything if this registration needs a payment we cannot take.
      if (p.totals && p.totals.totalMinor > 0) providerFor(providers, account.provider);
      return createRegistrations(tx, request, {
        ...options,
        plan: p,
        consent: competition.consent_required ? { type: "parent" } : null,
        schoolId: null,
        platformFeeBps: account.platformFeeBps,
      });
    });

    const registration = result.registrations[0]!;
    let payment = null;
    if (registration.status === "pending_payment" && result.order) {
      try {
        payment = (await startCheckout(db, providers, request, personal(auth), result.order.id, config.payments.appUrl)).payment;
      } catch (err) {
        // The seat stays held; the parent can retry checkout from the order.
        if (!(err instanceof AppError && err.code === "PAYMENT_UNAVAILABLE")) throw err;
      }
    }
    return reply.status(201).send({
      registration: presentRegistration(registration),
      order: result.order ? presentOrder(result.order) : null,
      payment: payment ? presentPayment(payment) : null,
    });
  });

  app.get("/registrations", async (request) => {
    const auth = requireAuth(request);
    const rows = await withContext(db, personal(auth), (tx) =>
      tx
        .selectFrom("registrations as r")
        .innerJoin("parent_children as pc", (j) => j.onRef("pc.student_id", "=", "r.student_id").on("pc.parent_user_id", "=", auth.userId))
        .selectAll("r")
        .orderBy("r.created_at", "desc")
        .execute(),
    );
    return { registrations: rows.map(presentRegistration) };
  });

  /** Parents may withdraw unpaid or waitlisted registrations. Paid ones go through the organizer (refund policy). */
  app.post("/registrations/:registrationId/cancel", async (request) => {
    const auth = requireAuth(request);
    const { registrationId } = parse(z.object({ registrationId: zUuid }), request.params);
    const now = new Date();
    const r = await withContext(db, personal(auth), async (tx) => {
      const r = await tx.selectFrom("registrations").selectAll().where("id", "=", registrationId).where("registered_by_user_id", "=", auth.userId).executeTakeFirst();
      if (!r) throw new AppError("NOT_FOUND");
      if (r.status === "cancelled") throw new AppError("CONFLICT", { reason: "already_cancelled" });
      if (r.status === "confirmed") throw new AppError("CONFLICT", { reason: "contact_organizer", hint: "Confirmed registrations are cancelled by the organizer" });
      await tx.updateTable("registrations").set({ status: "cancelled", cancelled_at: now, cancel_reason: "withdrawn_by_parent" }).where("id", "=", r.id).execute();
      await audit(tx, request, { tenantId: r.tenant_id, actorUserId: auth.userId, action: "registration.withdrawn", targetType: "registration", targetId: r.id, before: { status: r.status }, after: { status: "cancelled" } });
      return r;
    });
    await withContext(db, systemTenantContext(r.tenant_id), async (tx) => {
      if (r.order_id) await cancelOrderIfEmpty(tx, r.order_id, now, "withdrawn_by_parent");
    });
    await releaseAndPromote(db, request, r.competition_id, r.tenant_id, now);
    return { ok: true };
  });

  // ---------------------------------------------------------------- orders

  app.get("/orders", async (request) => {
    const auth = requireAuth(request);
    const rows = await withContext(db, personal(auth), (tx) => tx.selectFrom("orders").selectAll().where("buyer_user_id", "=", auth.userId).orderBy("created_at", "desc").execute());
    return { orders: rows.map((o) => presentOrder(o as Order)) };
  });

  app.get("/orders/:orderId", async (request) => {
    const auth = requireAuth(request);
    const { orderId } = parse(z.object({ orderId: zUuid }), request.params);
    return withContext(db, personal(auth), async (tx) => {
      const order = await tx.selectFrom("orders").selectAll().where("id", "=", orderId).where("buyer_user_id", "=", auth.userId).executeTakeFirst();
      if (!order) throw new AppError("NOT_FOUND");
      const [lines, payments, refunds, registrations] = await Promise.all([
        tx.selectFrom("order_lines").selectAll().where("order_id", "=", orderId).execute(),
        tx.selectFrom("payments").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute(),
        tx.selectFrom("refunds").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute(),
        tx.selectFrom("registrations").selectAll().where("order_id", "=", orderId).execute(),
      ]);
      return {
        order: presentOrder(order as Order),
        lines: lines.map((l) => ({ registrationId: l.registration_id, description: l.description, unitAmountMinor: Number(l.unit_amount_minor), discountMinor: Number(l.discount_minor), taxMinor: Number(l.tax_minor), totalMinor: Number(l.total_minor) })),
        payments: payments.map(presentPayment),
        refunds: refunds.map(presentRefund),
        registrations: registrations.map(presentRegistration),
      };
    });
  });

  /** Retry or re-open hosted checkout. */
  app.post("/orders/:orderId/checkout", async (request) => {
    const auth = requireAuth(request);
    const { orderId } = parse(z.object({ orderId: zUuid }), request.params);
    const { payment, reused } = await startCheckout(db, providers, request, personal(auth), orderId, config.payments.appUrl);
    return { payment: presentPayment(payment), reused };
  });

  app.get("/orders/:orderId/receipt", async (request, reply) => {
    const auth = requireAuth(request);
    const { orderId } = parse(z.object({ orderId: zUuid }), request.params);
    const data = await withContext(db, personal(auth), async (tx) => {
      const order = await tx.selectFrom("orders").selectAll().where("id", "=", orderId).where("buyer_user_id", "=", auth.userId).executeTakeFirst();
      if (!order) throw new AppError("NOT_FOUND");
      const lines = await tx.selectFrom("order_lines").select(["description", "total_minor"]).where("order_id", "=", orderId).execute();
      const me = await tx.selectFrom("users").select(["display_name", "email", "locale"]).where("id", "=", auth.userId).executeTakeFirstOrThrow();
      const { rows } = await sql<{ name: string }>`select name from app.tenant_public_profile(${order.tenant_id})`.execute(tx);
      return { order, lines, me, organizer: rows[0]?.name ?? "" };
    });
    const html = renderReceipt({ locale: request.headers["accept-language"] ? request.locale : data.me.locale, organizer: data.organizer, billedTo: `${data.me.display_name}${data.me.email ? ` <${data.me.email}>` : ""}`, order: data.order, lines: data.lines });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });
}
