import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import {
  AppError,
  CompetitionConfigSchema,
  checkOfferCode,
  computeOrderTotals,
  evaluateEligibility,
  resolvePrice,
  type CompetitionConfig,
  type EligibilityResult,
  type OfferCode,
  type OrderTotals,
  type TaxRule,
} from "@cos/core";
import { systemTenantContext, withContext, type DB, type Order, type Registration, type Tx } from "@cos/db";
import { audit } from "./audit.ts";
import { newId } from "./crypto.ts";

/**
 * Registration engine shared by the parent and school flows.
 *
 * Parents act without a tenant context (RLS limits them to their own
 * children and orders; prices, seat counts and offer codes are read through
 * narrow SECURITY DEFINER functions). School admins act inside their tenant.
 * Each registration attempt takes an advisory lock per competition, so
 * capacity and offer-code limits hold under concurrent registrations.
 */

export interface CompetitionForRegistration {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  visibility: string;
  fee_mode: "free" | "paid";
  currency: string | null;
  content_locales: string[];
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  waitlist_enabled: boolean;
  consent_required: boolean;
  requires_invite_code: boolean;
  consent_version: string;
  consent_text_i18n: unknown;
  payment_hold_minutes: number;
  versionId: string;
  config: CompetitionConfig;
}

export async function loadCompetitionForRegistration(tx: Tx, competitionId: string): Promise<CompetitionForRegistration> {
  const row = await tx
    .selectFrom("competitions as c")
    .innerJoin("competition_versions as v", "v.id", "c.current_version_id")
    .select([
      "c.id", "c.tenant_id", "c.name", "c.status", "c.visibility", "c.fee_mode", "c.currency", "c.content_locales",
      "c.registration_opens_at", "c.registration_closes_at", "c.waitlist_enabled", "c.consent_required", "c.requires_invite_code",
      "c.consent_version", "c.consent_text_i18n", "c.payment_hold_minutes", "v.id as version_id", "v.config",
    ])
    .where("c.id", "=", competitionId)
    .executeTakeFirst();
  if (!row) throw new AppError("NOT_FOUND", { field: "competitionId" });
  const { version_id, config, ...rest } = row;
  return { ...rest, versionId: version_id, config: CompetitionConfigSchema.parse(config) };
}

export function consentTextHash(c: Pick<CompetitionForRegistration, "consent_version" | "consent_text_i18n">): string {
  return createHash("sha256").update(c.consent_version).update(JSON.stringify(c.consent_text_i18n ?? {})).digest("hex");
}

export function checkRegistrationOpen(c: CompetitionForRegistration, channel: "parent" | "school", now: Date): void {
  if (c.status !== "published") throw new AppError("REGISTRATION_CLOSED", { reason: c.status === "cancelled" ? "cancelled" : "not_published" });
  if (c.registration_opens_at && now < c.registration_opens_at) throw new AppError("REGISTRATION_CLOSED", { reason: "not_open_yet", opensAt: c.registration_opens_at });
  if (c.registration_closes_at && now >= c.registration_closes_at) throw new AppError("REGISTRATION_CLOSED", { reason: "closed", closedAt: c.registration_closes_at });
  // Private competitions are filled by schools and organizers only.
  if (channel === "parent" && c.visibility === "private") throw new AppError("REGISTRATION_CLOSED", { reason: "private" });
}

/** Groups open for registration: enabled in a round that takes entries by registration. */
export function registrableGroupIds(config: CompetitionConfig): Set<string> {
  return new Set(config.rounds.filter((r) => r.entry.type === "registration").flatMap((r) => r.groups.filter((g) => g.enabled).map((g) => g.groupId)));
}

export interface EntryInput {
  studentId: string;
  groupId: string;
  grade: string | null;
  contentLocale: string;
  schoolId: string | null;
}

interface StudentFacts {
  id: string;
  date_of_birth: string | null;
  given_name: string | null;
  family_name: string | null;
}

export interface PlannedEntry extends EntryInput {
  eligibility: EligibilityResult & { gradeDeclared: string | null };
  status: "pending_payment" | "confirmed" | "waitlisted";
  possibleDuplicateOf: string | null;
  unitAmountMinor: number;
}

export interface QuoteInputs {
  prices: Array<{ id: string; groupId: string | null; amountMinor: number; startsAt: string | null; endsAt: string | null }>;
  tax: TaxRule | null;
}

export async function quoteInputs(tx: Tx, competitionId: string): Promise<QuoteInputs> {
  const { rows } = await sql<{ price_id: string | null; group_id: string | null; amount_minor: string | null; starts_at: Date | null; ends_at: Date | null; tax_rate_bps: number | null; tax_inclusive: boolean | null }>`
    select * from app.competition_quote_inputs(${competitionId})`.execute(tx);
  const first = rows[0];
  return {
    prices: rows
      .filter((r) => r.price_id)
      .map((r) => ({ id: r.price_id!, groupId: r.group_id, amountMinor: Number(r.amount_minor), startsAt: r.starts_at?.toISOString() ?? null, endsAt: r.ends_at?.toISOString() ?? null })),
    tax: first?.tax_rate_bps != null ? { rateBps: first.tax_rate_bps, inclusive: !!first.tax_inclusive } : null,
  };
}

export async function findOfferCode(tx: Tx, tenantId: string, code: string): Promise<OfferCode | null> {
  const { rows } = await sql<{
    id: string; competition_id: string | null; code: string; kind: "percent" | "fixed"; percent_bps: number | null; amount_minor: string | null;
    purpose: OfferCode["purpose"]; valid_from: Date | null; valid_until: Date | null; max_uses: number | null; max_uses_per_user: number | null; status: "active" | "disabled";
  }>`select * from app.find_offer_code(${tenantId}, ${code})`.execute(tx);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, code: r.code, kind: r.kind, percentBps: r.percent_bps, amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
    competitionId: r.competition_id, purpose: r.purpose, validFrom: r.valid_from?.toISOString() ?? null, validUntil: r.valid_until?.toISOString() ?? null,
    maxUses: r.max_uses, maxUsesPerUser: r.max_uses_per_user, status: r.status,
  };
}

export interface PlanOptions {
  competition: CompetitionForRegistration;
  entries: EntryInput[];
  students: Map<string, StudentFacts>;
  buyerUserId: string;
  offerCode: string | null;
  channel: "parent" | "school";
  paymentMethod: "online" | "invoice";
  now: Date;
}

export interface RegistrationPlan {
  entries: PlannedEntry[];
  totals: OrderTotals | null;
  offer: OfferCode | null;
  tax: TaxRule | null;
  /** Problems per entry; the whole batch is refused if any exist. */
  problems: Array<{ index: number; studentId: string; code: string; detail?: unknown }>;
}

/** Work out eligibility, duplicates, seats and price for a batch. Writes nothing. */
export async function planRegistrations(tx: Tx, o: PlanOptions): Promise<RegistrationPlan> {
  const c = o.competition;
  const groups = new Map(c.config.groups.map((g) => [g.id, g]));
  const open = registrableGroupIds(c.config);
  const inputs = c.fee_mode === "paid" ? await quoteInputs(tx, c.id) : { prices: [], tax: null };
  const problems: RegistrationPlan["problems"] = [];
  const seatsByGroup = new Map<string, number>();
  const seen = new Set<string>();
  const entries: PlannedEntry[] = [];

  for (const [index, e] of o.entries.entries()) {
    const problem = (code: string, detail?: unknown) => problems.push({ index, studentId: e.studentId, code, ...(detail !== undefined && { detail }) });
    const group = groups.get(e.groupId);
    const student = o.students.get(e.studentId);
    if (!student) { problem("STUDENT_NOT_FOUND"); continue; }
    if (!group || !open.has(e.groupId)) { problem("GROUP_NOT_OPEN"); continue; }
    if (seen.has(e.studentId)) { problem("STUDENT_REPEATED"); continue; }
    seen.add(e.studentId);
    if (!c.content_locales.includes(e.contentLocale)) { problem("LANGUAGE_NOT_OFFERED", { offered: c.content_locales }); continue; }

    const eligibility = evaluateEligibility(group.eligibility, { dateOfBirth: student.date_of_birth, grade: e.grade });
    if (!eligibility.eligible) { problem("NOT_ELIGIBLE", eligibility.failures); continue; }

    const { rows: live } = await sql<{ id: string; status: string }>`
      select id, status from registrations where competition_id = ${c.id} and student_id = ${e.studentId}
        and status in ('pending_payment', 'confirmed', 'waitlisted')`.execute(tx);
    if (live[0]) { problem("ALREADY_REGISTERED", { registrationId: live[0].id, status: live[0].status }); continue; }

    const { rows: dup } = await sql<{ id: string | null }>`select app.registration_possible_duplicate(${c.id}, ${e.studentId}) as id`.execute(tx);

    if (!seatsByGroup.has(e.groupId)) {
      const { rows } = await sql<{ n: number }>`select app.group_seats_taken(${c.id}, ${e.groupId}) as n`.execute(tx);
      seatsByGroup.set(e.groupId, rows[0]!.n);
    }
    const taken = seatsByGroup.get(e.groupId)!;
    const hasSeat = group.capacity === null || taken < group.capacity;
    if (!hasSeat && !c.waitlist_enabled) { problem("GROUP_FULL"); continue; }
    if (hasSeat) seatsByGroup.set(e.groupId, taken + 1);

    let unit = 0;
    if (c.fee_mode === "paid") {
      const price = resolvePrice(inputs.prices, e.groupId, o.now);
      if (!price) { problem("NO_PRICE"); continue; }
      unit = price.amountMinor;
    }
    entries.push({
      ...e,
      eligibility: { ...eligibility, gradeDeclared: e.grade },
      status: hasSeat ? "confirmed" : "waitlisted", // refined below once the total is known
      possibleDuplicateOf: dup[0]?.id ?? null,
      unitAmountMinor: unit,
    });
  }

  // Offer code (invite codes are required for invite-only competitions).
  let offer: OfferCode | null = null;
  if (o.offerCode) {
    offer = await findOfferCode(tx, c.tenant_id, o.offerCode);
    if (!offer) throw new AppError("OFFER_CODE_INVALID", { reason: "NOT_FOUND" });
    await sql`select pg_advisory_xact_lock(hashtext(${`offer:${offer.id}`}))`.execute(tx);
    const { rows } = await sql<{ total: number; by_user: number }>`select * from app.offer_code_uses(${offer.id}, ${o.buyerUserId})`.execute(tx);
    const rejection = checkOfferCode(offer, { competitionId: c.id, now: o.now, usesTotal: rows[0]!.total, usesByUser: rows[0]!.by_user, newUses: Math.max(1, entries.length) });
    if (rejection) throw new AppError("OFFER_CODE_INVALID", { reason: rejection });
  }
  if (c.requires_invite_code && offer?.purpose !== "invite") throw new AppError("OFFER_CODE_INVALID", { reason: "INVITE_REQUIRED" });

  let totals: OrderTotals | null = null;
  if (c.fee_mode === "paid" && entries.length) {
    totals = computeOrderTotals(entries.map((e, i) => ({ key: String(i), unitAmountMinor: e.unitAmountMinor })), offer, inputs.tax);
    // An entry that has a seat but still owes money is held pending payment, unless invoiced.
    entries.forEach((e, i) => {
      if (e.status === "confirmed" && totals!.lines[i]!.totalMinor > 0 && o.paymentMethod === "online") e.status = "pending_payment";
    });
  }
  return { entries, totals, offer, tax: inputs.tax, problems };
}

export interface CreateResult {
  registrations: Registration[];
  order: Order | null;
}

/** Write a planned batch: tenant link, registrations, consent, order + lines, offer redemption, audit. */
export async function createRegistrations(
  tx: Tx,
  request: FastifyRequest,
  o: PlanOptions & { plan: RegistrationPlan; consent: { type: "parent" | "school_attestation" } | null; schoolId: string | null; platformFeeBps: number },
): Promise<CreateResult> {
  const c = o.competition;
  const now = o.now;
  const holdUntil = new Date(now.getTime() + c.payment_hold_minutes * 60_000);
  let order: Order | null = null;

  if (o.plan.totals) {
    const { rows } = await sql<{ n: string }>`select app.next_order_number(${c.tenant_id}) as n`.execute(tx);
    const total = o.plan.totals.totalMinor;
    const free = total === 0;
    const invoice = !free && o.paymentMethod === "invoice";
    const values = {
      id: newId(),
      tenant_id: c.tenant_id,
      order_number: rows[0]!.n,
      competition_id: c.id,
      kind: o.channel,
      buyer_user_id: o.buyerUserId,
      school_id: o.channel === "school" ? o.schoolId : null,
      status: free ? ("paid" as const) : ("pending" as const),
      payment_method: free ? ("none" as const) : invoice ? ("invoice" as const) : ("online" as const),
      currency: c.currency!,
      subtotal_minor: o.plan.totals.subtotalMinor,
      discount_minor: o.plan.totals.discountMinor,
      tax_minor: o.plan.totals.taxMinor,
      total_minor: total,
      tax_rate_bps: o.plan.tax?.rateBps ?? null,
      tax_inclusive: o.plan.tax?.inclusive ?? null,
      offer_code_id: o.plan.offer?.id ?? null,
      platform_fee_bps: o.platformFeeBps,
      platform_fee_minor: Math.floor((total * o.platformFeeBps + 5000) / 10000),
      invoice_due_at: invoice ? new Date(now.getTime() + 30 * 86_400_000) : null,
      external_reference: null,
      expires_at: !free && !invoice ? holdUntil : null,
      paid_at: free ? now : null,
      cancelled_at: null,
    };
    await tx.insertInto("orders").values(values).execute();
    order = (await tx.selectFrom("orders").selectAll().where("id", "=", values.id).executeTakeFirstOrThrow()) as Order;
    if (o.plan.offer) {
      await tx.insertInto("offer_code_redemptions").values({ tenant_id: c.tenant_id, offer_code_id: o.plan.offer.id, order_id: order.id, user_id: o.buyerUserId, uses: o.plan.entries.length }).execute();
    }
  }

  const registrations: Registration[] = [];
  for (const [i, e] of o.plan.entries.entries()) {
    await sql`select app.connect_student_to_tenant(${c.tenant_id}, ${e.studentId})`.execute(tx);
    const id = newId();
    const status = e.status;
    await tx
      .insertInto("registrations")
      .values({
        id,
        tenant_id: c.tenant_id,
        competition_id: c.id,
        competition_version_id: c.versionId,
        group_id: e.groupId,
        student_id: e.studentId,
        registered_by_user_id: o.buyerUserId,
        channel: o.channel,
        school_id: e.schoolId,
        content_locale: e.contentLocale,
        declared_grade: e.grade,
        status,
        hold_expires_at: status === "pending_payment" ? holdUntil : null,
        waitlisted_at: status === "waitlisted" ? now : null,
        order_id: order?.id ?? null,
        eligibility: JSON.stringify(e.eligibility),
        possible_duplicate_of: e.possibleDuplicateOf,
        duplicate_resolution: null,
        needs_attention: e.possibleDuplicateOf ? "possible_duplicate" : null,
        cancel_reason: null,
        confirmed_at: status === "confirmed" ? now : null,
        cancelled_at: null,
      })
      .execute();
    if (order && o.plan.totals) {
      const line = o.plan.totals.lines[i]!;
      await tx
        .insertInto("order_lines")
        .values({
          tenant_id: c.tenant_id,
          order_id: order.id,
          registration_id: id,
          description: `${c.name} — ${c.config.groups.find((g) => g.id === e.groupId)?.key ?? "group"}`,
          unit_amount_minor: line.unitAmountMinor,
          discount_minor: line.discountMinor,
          tax_minor: line.taxMinor,
          total_minor: line.totalMinor,
        })
        .execute();
    }
    if (o.consent) {
      await tx
        .insertInto("consent_records")
        .values({
          tenant_id: c.tenant_id,
          competition_id: c.id,
          student_id: e.studentId,
          given_by_user_id: o.buyerUserId,
          consent_type: o.consent.type,
          consent_version: c.consent_version,
          consent_text_hash: consentTextHash(c),
          granted: true,
          ip: request.ip,
          user_agent: request.headers["user-agent"]?.slice(0, 500) ?? null,
        })
        .execute();
    }
    await audit(tx, request, {
      tenantId: c.tenant_id,
      actorUserId: o.buyerUserId,
      action: "registration.created",
      targetType: "registration",
      targetId: id,
      after: { competitionId: c.id, studentId: e.studentId, groupId: e.groupId, status, channel: o.channel, orderId: order?.id ?? null, possibleDuplicateOf: e.possibleDuplicateOf },
    });
    registrations.push((await tx.selectFrom("registrations").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as Registration);
  }
  return { registrations, order };
}

// ---------------------------------------------------------------- seats: expiry and waitlist

/**
 * Release unpaid holds that have expired, then fill free seats from the
 * waitlist. Runs as the system inside the competition's tenant, so it can act
 * on every registration regardless of who triggered it.
 */
export async function releaseAndPromote(db: DB, request: FastifyRequest | null, competitionId: string, tenantId: string, now = new Date()): Promise<void> {
  await withContext(db, systemTenantContext(tenantId), async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`competition:${competitionId}`}))`.execute(tx);
    const expired = await tx
      .updateTable("registrations")
      .set({ status: "cancelled", cancelled_at: now, cancel_reason: "payment_hold_expired" })
      .where("competition_id", "=", competitionId)
      .where("status", "=", "pending_payment")
      .where("hold_expires_at", "<=", now)
      .returning(["id", "order_id"])
      .execute();
    for (const r of expired) {
      await audit(tx, request, { tenantId, actorUserId: null, action: "registration.hold_expired", targetType: "registration", targetId: r.id, metadata: { via: "system" } });
      if (r.order_id) await cancelOrderIfEmpty(tx, r.order_id, now, "payment_hold_expired");
    }
    await promoteFromWaitlist(tx, request, competitionId, tenantId, now);
  });
}

const WAITLIST_OFFER_HOURS = 48;

export async function promoteFromWaitlist(tx: Tx, request: FastifyRequest | null, competitionId: string, tenantId: string, now: Date): Promise<string[]> {
  const comp = await loadCompetitionForRegistration(tx, competitionId);
  const promoted: string[] = [];
  for (const group of comp.config.groups) {
    if (group.capacity === null) continue;
    const { rows } = await sql<{ n: number }>`select app.group_seats_taken(${competitionId}, ${group.id}) as n`.execute(tx);
    let free = group.capacity - rows[0]!.n;
    if (free <= 0) continue;
    const waiting = await tx
      .selectFrom("registrations as r")
      .leftJoin("order_lines as l", "l.registration_id", "r.id")
      .select(["r.id", "r.order_id", "l.total_minor"])
      .where("r.competition_id", "=", competitionId)
      .where("r.group_id", "=", group.id)
      .where("r.status", "=", "waitlisted")
      .orderBy("r.waitlisted_at")
      .orderBy("r.id")
      .limit(free)
      .execute();
    for (const w of waiting) {
      const owes = w.order_id && Number(w.total_minor ?? 0) > 0;
      const hold = new Date(now.getTime() + WAITLIST_OFFER_HOURS * 3_600_000);
      await tx
        .updateTable("registrations")
        .set(owes ? { status: "pending_payment", hold_expires_at: hold } : { status: "confirmed", confirmed_at: now })
        .where("id", "=", w.id)
        .execute();
      if (owes && w.order_id) await tx.updateTable("orders").set({ expires_at: hold }).where("id", "=", w.order_id).where("status", "=", "pending").execute();
      await audit(tx, request, {
        tenantId,
        actorUserId: null,
        action: "registration.promoted_from_waitlist",
        targetType: "registration",
        targetId: w.id,
        after: { status: owes ? "pending_payment" : "confirmed", holdExpiresAt: owes ? hold : null },
        metadata: { via: "system" },
      });
      promoted.push(w.id);
      free--;
    }
  }
  return promoted;
}

/** Cancel an unpaid order once none of its registrations are live, and release its offer-code use. */
export async function cancelOrderIfEmpty(tx: Tx, orderId: string, now: Date, reason: string): Promise<void> {
  const live = await tx.selectFrom("registrations").select("id").where("order_id", "=", orderId).where("status", "in", ["pending_payment", "confirmed", "waitlisted"]).executeTakeFirst();
  if (live) return;
  const updated = await tx.updateTable("orders").set({ status: "cancelled", cancelled_at: now }).where("id", "=", orderId).where("status", "=", "pending").returning(["id", "tenant_id"]).executeTakeFirst();
  if (!updated) return;
  await tx.updateTable("offer_code_redemptions").set({ status: "released" }).where("order_id", "=", orderId).execute();
  await audit(tx, null, { tenantId: updated.tenant_id, actorUserId: null, action: "order.cancelled", targetType: "order", targetId: orderId, reason, metadata: { via: "system" } });
}
