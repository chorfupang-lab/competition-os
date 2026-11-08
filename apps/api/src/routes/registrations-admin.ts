import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError, evaluateEligibility, reconcile, resolvePrice, tenantNet, type Permission } from "@cos/core";
import { withContext, type Order, type Tx } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { completeRefund, paymentAccount, providerFor, startCheckout } from "../lib/payments.ts";
import { presentOrder, presentPayment, presentRefund, presentRegistration } from "../lib/present-commerce.ts";
import { renderReceipt } from "../lib/receipt.ts";
import {
  cancelOrderIfEmpty,
  checkRegistrationOpen,
  createRegistrations,
  loadCompetitionForRegistration,
  planRegistrations,
  promoteFromWaitlist,
  quoteInputs,
  registrableGroupIds,
  releaseAndPromote,
} from "../lib/registration.ts";
import { permissionsInCompetition, requirePermission, resolveTenantScope, type TenantScope } from "../lib/tenant-scope.ts";
import { parse, zLocale, zReason, zUuid } from "../lib/validation.ts";

const T = z.object({ tenantId: zUuid }).passthrough();
const zMinor = z.number().int().min(0).max(1_000_000_000);
const zCurrency = z.string().regex(/^[A-Z]{3}$/);

const SettingsBody = z.object({
  registrationOpensAt: z.iso.datetime({ offset: true }).nullable().optional(),
  registrationClosesAt: z.iso.datetime({ offset: true }).nullable().optional(),
  waitlistEnabled: z.boolean().optional(),
  consentRequired: z.boolean().optional(),
  consentVersion: z.string().trim().min(1).max(40).optional(),
  consentTextI18n: z.partialRecord(zLocale, z.string().max(20_000)).optional(),
  requiresInviteCode: z.boolean().optional(),
  taxRateId: zUuid.nullable().optional(),
  paymentHoldMinutes: z.number().int().min(5).max(10_080).optional(),
});

const PriceBody = z.object({
  groupId: zUuid.nullable().default(null),
  label: z.string().trim().max(100).default(""),
  amountMinor: zMinor,
  startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

const OfferBody = z
  .object({
    code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/),
    competitionId: zUuid.nullable().default(null),
    kind: z.enum(["percent", "fixed"]),
    percentBps: z.number().int().min(1).max(10_000).optional(),
    amountMinor: z.number().int().min(1).optional(),
    purpose: z.enum(["promotion", "scholarship", "invite", "trial"]).default("promotion"),
    validFrom: z.iso.datetime({ offset: true }).nullable().default(null),
    validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
    maxUses: z.number().int().min(1).nullable().default(null),
    maxUsesPerUser: z.number().int().min(1).nullable().default(null),
  })
  .refine((b) => (b.kind === "percent" ? b.percentBps !== undefined && b.amountMinor === undefined : b.amountMinor !== undefined && b.percentBps === undefined), {
    message: "percent codes need percentBps; fixed codes need amountMinor",
    path: ["kind"],
  });

const SchoolRegistrationBody = z.object({
  schoolId: zUuid,
  entries: z.array(z.object({ studentId: zUuid, groupId: zUuid, contentLocale: zLocale.optional(), grade: z.string().trim().max(40).optional() })).min(1).max(500),
  paymentMethod: z.enum(["online", "invoice"]).default("invoice"),
  offerCode: z.string().trim().min(3).max(40).optional(),
  /** The school confirms it holds parental consent for every listed student. */
  consentAttestation: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const GatewayTxn = z.object({
  providerTxnId: z.string().min(1).max(200),
  kind: z.enum(["payment", "refund"]),
  providerRef: z.string().min(1).max(200),
  amountMinor: zMinor,
  feeMinor: zMinor.default(0),
  currency: zCurrency,
  settledAt: z.iso.datetime({ offset: true }),
});

export async function adminRegistrationRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, providers } = app.deps;

  const scopeOf = (request: FastifyRequest) => resolveTenantScope(db, request, parse(T, request.params).tenantId);
  const needInCompetition = (scope: TenantScope, competitionId: string, p: Permission) => {
    if (!permissionsInCompetition(scope, competitionId).has(p)) throw new AppError("FORBIDDEN");
  };
  const cid = (request: FastifyRequest) => parse(z.object({ competitionId: zUuid }).passthrough(), request.params).competitionId;
  const ownCompetition = async (tx: Tx, scope: TenantScope, competitionId: string) => {
    const c = await tx.selectFrom("competitions").selectAll().where("id", "=", competitionId).where("tenant_id", "=", scope.tenant.id).executeTakeFirst();
    if (!c) throw new AppError("NOT_FOUND");
    return c;
  };
  const actor = (scope: TenantScope) => ({ tenantId: scope.tenant.id, actorUserId: scope.auth.userId });

  // ================================================================ settings, prices, tax, offer codes

  app.patch("/competitions/:competitionId/registration-settings", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    needInCompetition(scope, competitionId, "competitions.manage");
    const body = parse(SettingsBody, request.body);
    return withContext(db, scope.db, async (tx) => {
      const before = await ownCompetition(tx, scope, competitionId);
      if (body.taxRateId) {
        const t = await tx.selectFrom("tax_rates").select("id").where("id", "=", body.taxRateId).where("status", "=", "active").executeTakeFirst();
        if (!t) throw new AppError("NOT_FOUND", { field: "taxRateId" });
      }
      const opens = body.registrationOpensAt !== undefined ? body.registrationOpensAt : before.registration_opens_at?.toISOString() ?? null;
      const closes = body.registrationClosesAt !== undefined ? body.registrationClosesAt : before.registration_closes_at?.toISOString() ?? null;
      if (opens && closes && Date.parse(closes) <= Date.parse(opens)) throw new AppError("VALIDATION_FAILED", [{ path: "registrationClosesAt", message: "must be after registrationOpensAt" }]);
      const changes = {
        ...(body.registrationOpensAt !== undefined && { registration_opens_at: body.registrationOpensAt }),
        ...(body.registrationClosesAt !== undefined && { registration_closes_at: body.registrationClosesAt }),
        ...(body.waitlistEnabled !== undefined && { waitlist_enabled: body.waitlistEnabled }),
        ...(body.consentRequired !== undefined && { consent_required: body.consentRequired }),
        ...(body.consentVersion !== undefined && { consent_version: body.consentVersion }),
        ...(body.consentTextI18n !== undefined && { consent_text_i18n: JSON.stringify(body.consentTextI18n) }),
        ...(body.requiresInviteCode !== undefined && { requires_invite_code: body.requiresInviteCode }),
        ...(body.taxRateId !== undefined && { tax_rate_id: body.taxRateId }),
        ...(body.paymentHoldMinutes !== undefined && { payment_hold_minutes: body.paymentHoldMinutes }),
      };
      if (Object.keys(changes).length) {
        await tx.updateTable("competitions").set(changes).where("id", "=", competitionId).execute();
        await audit(tx, request, { ...actor(scope), action: "competition.registration_settings_updated", targetType: "competition", targetId: competitionId, after: body });
      }
      const c = await ownCompetition(tx, scope, competitionId);
      return {
        settings: {
          registrationOpensAt: c.registration_opens_at, registrationClosesAt: c.registration_closes_at, waitlistEnabled: c.waitlist_enabled,
          consentRequired: c.consent_required, consentVersion: c.consent_version, consentTextI18n: c.consent_text_i18n, requiresInviteCode: c.requires_invite_code,
          taxRateId: c.tax_rate_id, paymentHoldMinutes: c.payment_hold_minutes,
        },
      };
    });
  });

  app.get("/competitions/:competitionId/prices", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    needInCompetition(scope, competitionId, "competitions.manage");
    const rows = await withContext(db, scope.db, (tx) => tx.selectFrom("competition_prices").selectAll().where("competition_id", "=", competitionId).orderBy("created_at").execute());
    return { prices: rows.map((p) => ({ id: p.id, groupId: p.group_id, label: p.label, amountMinor: Number(p.amount_minor), startsAt: p.starts_at, endsAt: p.ends_at, status: p.status })) };
  });

  app.post("/competitions/:competitionId/prices", async (request, reply) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    needInCompetition(scope, competitionId, "competitions.manage");
    const body = parse(PriceBody, request.body);
    if (body.startsAt && body.endsAt && Date.parse(body.endsAt) <= Date.parse(body.startsAt)) throw new AppError("VALIDATION_FAILED", [{ path: "endsAt", message: "must be after startsAt" }]);
    const price = await withContext(db, scope.db, async (tx) => {
      const c = await ownCompetition(tx, scope, competitionId);
      if (c.fee_mode !== "paid") throw new AppError("CONFLICT", { reason: "competition_is_free" });
      const p = await tx
        .insertInto("competition_prices")
        .values({ tenant_id: scope.tenant.id, competition_id: competitionId, group_id: body.groupId, label: body.label, amount_minor: body.amountMinor, starts_at: body.startsAt, ends_at: body.endsAt, created_by: scope.auth.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "price.created", targetType: "competition_price", targetId: p.id, after: { ...body, currency: c.currency } });
      return p;
    });
    return reply.status(201).send({ price: { id: price.id, groupId: price.group_id, amountMinor: Number(price.amount_minor) } });
  });

  app.post("/competitions/:competitionId/prices/:priceId/archive", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    needInCompetition(scope, competitionId, "competitions.manage");
    const { priceId } = parse(z.object({ priceId: zUuid }).passthrough(), request.params);
    await withContext(db, scope.db, async (tx) => {
      const r = await tx.updateTable("competition_prices").set({ status: "archived" }).where("id", "=", priceId).where("competition_id", "=", competitionId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new AppError("NOT_FOUND");
      await audit(tx, request, { ...actor(scope), action: "price.archived", targetType: "competition_price", targetId: priceId });
    });
    return { ok: true };
  });

  app.get("/tax-rates", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const rows = await withContext(db, scope.db, (tx) => tx.selectFrom("tax_rates").selectAll().orderBy("name").execute());
    return { taxRates: rows.map((t) => ({ id: t.id, name: t.name, rateBps: t.rate_bps, inclusive: t.inclusive, status: t.status })) };
  });

  app.post("/tax-rates", async (request, reply) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), rateBps: z.number().int().min(0).max(10_000), inclusive: z.boolean() }), request.body);
    const t = await withContext(db, scope.db, async (tx) => {
      const t = await tx.insertInto("tax_rates").values({ tenant_id: scope.tenant.id, name: body.name, rate_bps: body.rateBps, inclusive: body.inclusive }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "tax_rate.created", targetType: "tax_rate", targetId: t.id, after: body });
      return t;
    });
    return reply.status(201).send({ taxRate: { id: t.id, name: t.name, rateBps: t.rate_bps, inclusive: t.inclusive } });
  });

  app.get("/offer-codes", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const rows = await withContext(db, scope.db, (tx) => tx.selectFrom("offer_codes").selectAll().orderBy("created_at", "desc").execute());
    const uses = await withContext(db, scope.db, (tx) =>
      tx.selectFrom("offer_code_redemptions").select(["offer_code_id", (eb) => eb.fn.sum<string>("uses").as("n")]).where("status", "=", "active").groupBy("offer_code_id").execute(),
    );
    const used = new Map(uses.map((u) => [u.offer_code_id, Number(u.n)]));
    return {
      offerCodes: rows.map((o) => ({
        id: o.id, code: o.code, competitionId: o.competition_id, kind: o.kind, percentBps: o.percent_bps, amountMinor: o.amount_minor === null ? null : Number(o.amount_minor),
        purpose: o.purpose, validFrom: o.valid_from, validUntil: o.valid_until, maxUses: o.max_uses, maxUsesPerUser: o.max_uses_per_user, status: o.status, used: used.get(o.id) ?? 0,
      })),
    };
  });

  app.post("/offer-codes", async (request, reply) => {
    const scope = await scopeOf(request);
    const body = parse(OfferBody, request.body);
    if (body.competitionId) needInCompetition(scope, body.competitionId, "payments.manage");
    else requirePermission(scope, "payments.manage");
    const o = await withContext(db, scope.db, async (tx) => {
      if (body.competitionId) await ownCompetition(tx, scope, body.competitionId);
      const o = await tx
        .insertInto("offer_codes")
        .values({
          tenant_id: scope.tenant.id, competition_id: body.competitionId, code: body.code, kind: body.kind, percent_bps: body.percentBps ?? null, amount_minor: body.amountMinor ?? null,
          purpose: body.purpose, valid_from: body.validFrom, valid_until: body.validUntil, max_uses: body.maxUses, max_uses_per_user: body.maxUsesPerUser, created_by: scope.auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "offer_code.created", targetType: "offer_code", targetId: o.id, after: body });
      return o;
    });
    return reply.status(201).send({ offerCode: { id: o.id, code: o.code } });
  });

  app.post("/offer-codes/:offerCodeId/status", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const { offerCodeId } = parse(z.object({ offerCodeId: zUuid }).passthrough(), request.params);
    const { status } = parse(z.object({ status: z.enum(["active", "disabled"]) }), request.body);
    await withContext(db, scope.db, async (tx) => {
      const r = await tx.updateTable("offer_codes").set({ status }).where("id", "=", offerCodeId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new AppError("NOT_FOUND");
      await audit(tx, request, { ...actor(scope), action: "offer_code.status_changed", targetType: "offer_code", targetId: offerCodeId, after: { status } });
    });
    return { ok: true };
  });

  // ================================================================ registrations

  app.get("/competitions/:competitionId/registrations", async (request) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    needInCompetition(scope, competitionId, "registrations.manage");
    const q = parse(
      z.object({
        status: z.enum(["pending_payment", "confirmed", "waitlisted", "cancelled"]).optional(),
        groupId: zUuid.optional(),
        attention: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    await releaseAndPromote(db, request, competitionId, scope.tenant.id);
    return withContext(db, scope.db, async (tx) => {
      await ownCompetition(tx, scope, competitionId);
      let query = tx.selectFrom("registrations").selectAll().where("competition_id", "=", competitionId).orderBy("created_at").limit(q.limit).offset(q.offset);
      if (q.status) query = query.where("status", "=", q.status);
      if (q.groupId) query = query.where("group_id", "=", q.groupId);
      if (q.attention === "true") query = query.where("needs_attention", "is not", null);
      const rows = await query.execute();
      const counts = await tx.selectFrom("registrations").select(["group_id", "status", (eb) => eb.fn.countAll<string>().as("n")]).where("competition_id", "=", competitionId).groupBy(["group_id", "status"]).execute();
      return { registrations: rows.map(presentRegistration), counts: counts.map((c) => ({ groupId: c.group_id, status: c.status, count: Number(c.n) })) };
    });
  });

  async function loadRegistration(tx: Tx, scope: TenantScope, registrationId: string) {
    const r = await tx.selectFrom("registrations").selectAll().where("id", "=", registrationId).where("tenant_id", "=", scope.tenant.id).forUpdate().executeTakeFirst();
    if (!r) throw new AppError("NOT_FOUND");
    needInCompetition(scope, r.competition_id, "registrations.manage");
    return r;
  }

  /** Cancel a registration. Money is returned separately via a refund on the order. */
  app.post("/registrations/:registrationId/cancel", async (request) => {
    const scope = await scopeOf(request);
    const { registrationId } = parse(z.object({ registrationId: zUuid }).passthrough(), request.params);
    const { reason } = parse(z.object({ reason: zReason }), request.body);
    const now = new Date();
    const r = await withContext(db, scope.db, async (tx) => {
      const r = await loadRegistration(tx, scope, registrationId);
      if (r.status === "cancelled") throw new AppError("CONFLICT", { reason: "already_cancelled" });
      await tx.updateTable("registrations").set({ status: "cancelled", cancelled_at: now, cancel_reason: reason }).where("id", "=", r.id).execute();
      await audit(tx, request, { ...actor(scope), action: "registration.cancelled", targetType: "registration", targetId: r.id, reason, before: { status: r.status }, after: { status: "cancelled" } });
      if (r.order_id) await cancelOrderIfEmpty(tx, r.order_id, now, reason);
      await promoteFromWaitlist(tx, request, r.competition_id, scope.tenant.id, now);
      return r;
    });
    return { ok: true, registrationId: r.id };
  });

  /** Amendment: move to another group. Eligibility and capacity are re-checked; prices must match. */
  app.post("/registrations/:registrationId/change-group", async (request) => {
    const scope = await scopeOf(request);
    const { registrationId } = parse(z.object({ registrationId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ groupId: zUuid, reason: zReason, grade: z.string().trim().max(40).optional(), overrideEligibility: z.boolean().default(false) }), request.body);
    const updated = await withContext(db, scope.db, async (tx) => {
      const r = await loadRegistration(tx, scope, registrationId);
      if (r.status === "cancelled") throw new AppError("CONFLICT", { reason: "cancelled" });
      if (r.group_id === body.groupId) throw new AppError("CONFLICT", { reason: "same_group" });
      await sql`select pg_advisory_xact_lock(hashtext(${`competition:${r.competition_id}`}))`.execute(tx);
      const comp = await loadCompetitionForRegistration(tx, r.competition_id);
      const group = comp.config.groups.find((g) => g.id === body.groupId);
      if (!group || !registrableGroupIds(comp.config).has(body.groupId)) throw new AppError("VALIDATION_FAILED", [{ path: "groupId", message: "GROUP_NOT_OPEN" }]);
      const student = await tx.selectFrom("students").select(["date_of_birth"]).where("id", "=", r.student_id).executeTakeFirstOrThrow();
      const grade = body.grade ?? r.declared_grade;
      const eligibility = evaluateEligibility(group.eligibility, { dateOfBirth: student.date_of_birth, grade });
      if (!eligibility.eligible && !body.overrideEligibility) throw new AppError("NOT_ELIGIBLE", eligibility.failures);
      if (group.capacity !== null && r.status !== "waitlisted") {
        const { rows } = await sql<{ n: number }>`select app.group_seats_taken(${r.competition_id}, ${body.groupId}) as n`.execute(tx);
        if (rows[0]!.n >= group.capacity) throw new AppError("CONFLICT", { reason: "group_full" });
      }
      if (comp.fee_mode === "paid") {
        const { prices } = await quoteInputs(tx, r.competition_id);
        const now = new Date();
        if (resolvePrice(prices, r.group_id, now)?.amountMinor !== resolvePrice(prices, body.groupId, now)?.amountMinor) {
          throw new AppError("CONFLICT", { reason: "price_differs", hint: "Cancel and re-register, with a refund if needed" });
        }
      }
      const u = await tx
        .updateTable("registrations")
        .set({ group_id: body.groupId, declared_grade: grade, eligibility: JSON.stringify({ ...eligibility, gradeDeclared: grade, overridden: !eligibility.eligible }) })
        .where("id", "=", r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        ...actor(scope),
        action: "registration.group_changed",
        targetType: "registration",
        targetId: r.id,
        reason: body.reason,
        before: { groupId: r.group_id },
        after: { groupId: body.groupId, eligibilityOverridden: !eligibility.eligible },
      });
      await promoteFromWaitlist(tx, request, r.competition_id, scope.tenant.id, new Date());
      return u;
    });
    return { registration: presentRegistration(updated) };
  });

  /** Transfer a registration to another student (e.g. a sibling), keeping its payment. */
  app.post("/registrations/:registrationId/transfer", async (request) => {
    const scope = await scopeOf(request);
    const { registrationId } = parse(z.object({ registrationId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ studentId: zUuid, reason: zReason, grade: z.string().trim().max(40).optional() }), request.body);
    const updated = await withContext(db, scope.db, async (tx) => {
      const r = await loadRegistration(tx, scope, registrationId);
      if (r.status === "cancelled") throw new AppError("CONFLICT", { reason: "cancelled" });
      // The receiving student must be visible to this tenant (RLS).
      const student = await tx
        .selectFrom("students")
        .innerJoin("tenant_students as ts", (j) => j.onRef("ts.student_id", "=", "students.id").on("ts.tenant_id", "=", scope.tenant.id))
        .select(["students.id", "students.date_of_birth"])
        .where("students.id", "=", body.studentId)
        .executeTakeFirst();
      if (!student) throw new AppError("NOT_FOUND", { field: "studentId" });
      const comp = await loadCompetitionForRegistration(tx, r.competition_id);
      const group = comp.config.groups.find((g) => g.id === r.group_id)!;
      const grade = body.grade ?? null;
      const eligibility = evaluateEligibility(group.eligibility, { dateOfBirth: student.date_of_birth, grade });
      if (!eligibility.eligible) throw new AppError("NOT_ELIGIBLE", eligibility.failures);
      const u = await tx
        .updateTable("registrations")
        .set({ student_id: body.studentId, declared_grade: grade, eligibility: JSON.stringify({ ...eligibility, gradeDeclared: grade }), possible_duplicate_of: null, needs_attention: null })
        .where("id", "=", r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "registration.transferred", targetType: "registration", targetId: r.id, reason: body.reason, before: { studentId: r.student_id }, after: { studentId: body.studentId } });
      return u;
    });
    return { registration: presentRegistration(updated) };
  });

  /** Resolve a possible-duplicate flag: confirm they are different people, or cancel this registration. */
  app.post("/registrations/:registrationId/duplicate", async (request) => {
    const scope = await scopeOf(request);
    const { registrationId } = parse(z.object({ registrationId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ resolution: z.enum(["not_duplicate", "cancelled"]), reason: zReason }), request.body);
    const now = new Date();
    const updated = await withContext(db, scope.db, async (tx) => {
      const r = await loadRegistration(tx, scope, registrationId);
      if (!r.possible_duplicate_of || r.duplicate_resolution) throw new AppError("CONFLICT", { reason: "nothing_to_resolve" });
      const u = await tx
        .updateTable("registrations")
        .set({
          duplicate_resolution: body.resolution,
          needs_attention: null,
          ...(body.resolution === "cancelled" && { status: "cancelled" as const, cancelled_at: now, cancel_reason: `duplicate: ${body.reason}` }),
        })
        .where("id", "=", r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...actor(scope), action: "registration.duplicate_resolved", targetType: "registration", targetId: r.id, reason: body.reason, after: { resolution: body.resolution, duplicateOf: r.possible_duplicate_of } });
      if (body.resolution === "cancelled") {
        if (r.order_id) await cancelOrderIfEmpty(tx, r.order_id, now, "duplicate");
        await promoteFromWaitlist(tx, request, r.competition_id, scope.tenant.id, now);
      }
      return u;
    });
    return { registration: presentRegistration(updated) };
  });

  // ================================================================ school flow

  /**
   * School bulk registration:
   *   Roster → Student IDs → Competition/Group → Package seats → Submit
   * Students must be on the school's roster; grades come from the roster unless given.
   */
  app.post("/competitions/:competitionId/school-registrations", async (request, reply) => {
    const scope = await scopeOf(request);
    const competitionId = cid(request);
    const body = parse(SchoolRegistrationBody, request.body);
    const perms = permissionsInCompetition(scope, competitionId);
    const ownSchool = scope.schoolIds.includes(body.schoolId) && scope.permissions.has("registrations.submit_school");
    if (!ownSchool && !perms.has("registrations.manage")) throw new AppError("FORBIDDEN");
    if (!body.consentAttestation && !body.dryRun) throw new AppError("CONSENT_REQUIRED", { field: "consentAttestation" });
    const now = new Date();
    await releaseAndPromote(db, request, competitionId, scope.tenant.id, now);

    const result = await withContext(db, scope.db, async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`competition:${competitionId}`}))`.execute(tx);
      await ownCompetition(tx, scope, competitionId);
      const competition = await loadCompetitionForRegistration(tx, competitionId);
      checkRegistrationOpen(competition, "school", now);
      const roster = await tx
        .selectFrom("school_students as ss")
        .innerJoin("students as s", "s.id", "ss.student_id")
        .select(["s.id", "s.date_of_birth", "s.given_name", "s.family_name", "ss.grade"])
        .where("ss.school_id", "=", body.schoolId)
        .where("ss.status", "=", "active")
        .where("ss.student_id", "in", body.entries.map((e) => e.studentId))
        .execute();
      const byId = new Map(roster.map((s) => [s.id, s]));
      const options = {
        competition,
        entries: body.entries.map((e) => ({
          studentId: e.studentId,
          groupId: e.groupId,
          grade: e.grade ?? byId.get(e.studentId)?.grade ?? null,
          contentLocale: e.contentLocale ?? competition.content_locales[0]!,
          schoolId: body.schoolId,
        })),
        students: new Map(roster.map((s) => [s.id, s])),
        buyerUserId: scope.auth.userId,
        offerCode: body.offerCode ?? null,
        channel: "school" as const,
        paymentMethod: body.paymentMethod,
        now,
      };
      const plan = await planRegistrations(tx, options);
      const preview = {
        entries: plan.entries.map((e) => ({ studentId: e.studentId, groupId: e.groupId, outcome: e.status, possibleDuplicate: e.possibleDuplicateOf !== null })),
        problems: plan.problems,
        totals: plan.totals,
        currency: competition.currency,
      };
      if (body.dryRun) return { status: 200, payload: { dryRun: true, ...preview } };
      if (plan.problems.length) throw new AppError("CONFLICT", { reason: "entries_have_problems", problems: plan.problems });
      const account = await paymentAccount(tx, competition.tenant_id);
      if (plan.totals && plan.totals.totalMinor > 0 && body.paymentMethod === "online") providerFor(providers, account.provider);
      const created = await createRegistrations(tx, request, { ...options, plan, consent: { type: "school_attestation" }, schoolId: body.schoolId, platformFeeBps: account.platformFeeBps });
      return { status: 201, payload: { registrations: created.registrations.map(presentRegistration), order: created.order ? presentOrder(created.order) : null, orderId: created.order?.id ?? null } };
    });

    let payment = null;
    const orderId = (result.payload as { orderId?: string | null }).orderId;
    if (result.status === 201 && orderId && body.paymentMethod === "online") {
      payment = (await startCheckout(db, providers, request, scope.db, orderId, config.payments.appUrl).catch(() => null))?.payment ?? null;
    }
    return reply.status(result.status).send({ ...result.payload, payment: payment ? presentPayment(payment) : null });
  });

  // ================================================================ orders, refunds, invoices

  app.get("/orders", async (request) => {
    const scope = await scopeOf(request);
    const q = parse(
      z.object({
        competitionId: zUuid.optional(),
        status: z.enum(["pending", "paid", "failed", "cancelled", "refunded", "partially_refunded"]).optional(),
        q: z.string().trim().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    if (q.competitionId) needInCompetition(scope, q.competitionId, "payments.manage");
    else requirePermission(scope, "payments.manage");
    const rows = await withContext(db, scope.db, (tx) => {
      let query = tx.selectFrom("orders as o").innerJoin("users as u", "u.id", "o.buyer_user_id").selectAll("o").select(["u.email as buyer_email", "u.display_name as buyer_name"]).where("o.tenant_id", "=", scope.tenant.id);
      if (q.competitionId) query = query.where("o.competition_id", "=", q.competitionId);
      if (q.status) query = query.where("o.status", "=", q.status);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query = query.where((eb) => eb.or([eb("o.order_number", "ilike", like), eb("u.email", "ilike", like), eb("u.display_name", "ilike", like)]));
      }
      return query.orderBy("o.created_at", "desc").limit(q.limit).offset(q.offset).execute();
    });
    return { orders: rows.map((o) => ({ ...presentOrder(o as Order), buyer: { email: o.buyer_email, name: o.buyer_name } })) };
  });

  async function loadOrder(tx: Tx, scope: TenantScope, orderId: string, forUpdate = false) {
    let q = tx.selectFrom("orders").selectAll().where("id", "=", orderId).where("tenant_id", "=", scope.tenant.id);
    if (forUpdate) q = q.forUpdate();
    const o = await q.executeTakeFirst();
    if (!o) throw new AppError("NOT_FOUND");
    needInCompetition(scope, o.competition_id, "payments.manage");
    return o as Order;
  }

  app.get("/orders/:orderId", async (request) => {
    const scope = await scopeOf(request);
    const { orderId } = parse(z.object({ orderId: zUuid }).passthrough(), request.params);
    return withContext(db, scope.db, async (tx) => {
      const order = await loadOrder(tx, scope, orderId);
      const [lines, payments, refunds, registrations] = await Promise.all([
        tx.selectFrom("order_lines").selectAll().where("order_id", "=", orderId).execute(),
        tx.selectFrom("payments").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute(),
        tx.selectFrom("refunds").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute(),
        tx.selectFrom("registrations").selectAll().where("order_id", "=", orderId).execute(),
      ]);
      const gatewayFee = payments.reduce((s, p) => s + Number(p.gateway_fee_minor ?? 0), 0);
      const gross = ["paid", "partially_refunded", "refunded"].includes(order.status) ? Number(order.total_minor) : 0;
      return {
        order: presentOrder(order),
        lines: lines.map((l) => ({ registrationId: l.registration_id, description: l.description, totalMinor: Number(l.total_minor) })),
        payments: payments.map(presentPayment),
        refunds: refunds.map(presentRefund),
        registrations: registrations.map(presentRegistration),
        economics: {
          grossMinor: gross,
          gatewayFeeMinor: gatewayFee,
          platformFeeMinor: gross ? Number(order.platform_fee_minor) : 0,
          refundedMinor: Number(order.refunded_minor),
          tenantNetMinor: tenantNet({ grossMinor: gross, gatewayFeeMinor: gatewayFee, platformFeeMinor: gross ? Number(order.platform_fee_minor) : 0, refundedMinor: Number(order.refunded_minor) }),
        },
      };
    });
  });

  /**
   * Refund all or part of a paid order (admin-initiated, reason required).
   * Listed registrations are cancelled at once so their seats are released.
   * Online payments are refunded through the provider; the refund is final
   * when its webhook arrives. Invoice orders are recorded as refunded offline.
   */
  app.post("/orders/:orderId/refunds", async (request, reply) => {
    const scope = await scopeOf(request);
    const { orderId } = parse(z.object({ orderId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ amountMinor: z.number().int().min(1).optional(), registrationIds: z.array(zUuid).max(500).default([]), reason: zReason }), request.body);
    const now = new Date();
    const prep = await withContext(db, scope.db, async (tx) => {
      const order = await loadOrder(tx, scope, orderId, true);
      if (!["paid", "partially_refunded"].includes(order.status)) throw new AppError("CONFLICT", { reason: "order_not_refundable", status: order.status });
      const pending = await tx.selectFrom("refunds").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_minor"), sql<string>`0`).as("n")).where("order_id", "=", orderId).where("status", "=", "pending").executeTakeFirstOrThrow();
      const refundable = Number(order.total_minor) - Number(order.refunded_minor) - Number(pending.n);
      const lines = await tx.selectFrom("order_lines").select(["registration_id", "total_minor"]).where("order_id", "=", orderId).execute();
      const selected = lines.filter((l) => body.registrationIds.includes(l.registration_id));
      if (selected.length !== body.registrationIds.length) throw new AppError("VALIDATION_FAILED", [{ path: "registrationIds", message: "not all registrations belong to this order" }]);
      const amount = body.amountMinor ?? Math.min(refundable, selected.length ? selected.reduce((s, l) => s + Number(l.total_minor), 0) : refundable);
      if (amount <= 0 || amount > refundable) throw new AppError("VALIDATION_FAILED", [{ path: "amountMinor", message: `refundable amount is ${refundable}` }]);
      const payment = order.payment_method === "online"
        ? await tx.selectFrom("payments").selectAll().where("order_id", "=", orderId).where("status", "=", "succeeded").executeTakeFirst()
        : undefined;
      if (order.payment_method === "online" && !payment) throw new AppError("CONFLICT", { reason: "no_settled_payment" });
      const refund = await tx
        .insertInto("refunds")
        .values({ tenant_id: scope.tenant.id, order_id: orderId, payment_id: payment?.id ?? null, amount_minor: amount, currency: order.currency, reason: body.reason, status: "pending", provider_refund_id: null, registration_ids: body.registrationIds, requested_by: scope.auth.userId, completed_at: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (body.registrationIds.length) {
        await tx.updateTable("registrations").set({ status: "cancelled", cancelled_at: now, cancel_reason: `refund: ${body.reason}` }).where("id", "in", body.registrationIds).where("status", "!=", "cancelled").execute();
      }
      await audit(tx, request, { ...actor(scope), action: "refund.requested", targetType: "order", targetId: orderId, reason: body.reason, after: { refundId: refund.id, amountMinor: amount, registrationIds: body.registrationIds } });
      if (!payment) await completeRefund(tx, request, refund.id, now, { via: "offline", recordedBy: scope.auth.userId });
      await promoteFromWaitlist(tx, request, order.competition_id, scope.tenant.id, now);
      const account = await paymentAccount(tx, scope.tenant.id);
      return { order, refund, payment, account };
    });

    if (prep.payment) {
      const provider = providerFor(providers, prep.payment.provider);
      try {
        const res = await provider.refund({
          merchantAccountId: prep.account.externalAccountId!,
          providerPaymentId: prep.payment.provider_payment_id,
          idempotencyKey: prep.refund.id,
          amountMinor: Number(prep.refund.amount_minor),
          currency: prep.refund.currency,
          reason: body.reason,
        });
        await withContext(db, scope.db, async (tx) => {
          await tx.updateTable("refunds").set({ provider_refund_id: res.providerRefundId, ...(res.status === "failed" && { status: "failed", completed_at: new Date() }) }).where("id", "=", prep.refund.id).execute();
          if (res.status === "succeeded") await completeRefund(tx, request, prep.refund.id, new Date(), { via: "provider_sync" });
        });
      } catch (err) {
        request.log.warn({ err, refundId: prep.refund.id }, "provider refund failed");
        await withContext(db, scope.db, async (tx) => {
          await tx.updateTable("refunds").set({ status: "failed", completed_at: new Date() }).where("id", "=", prep.refund.id).execute();
          await audit(tx, request, { ...actor(scope), action: "refund.failed", targetType: "order", targetId: orderId, after: { refundId: prep.refund.id, error: "provider_unavailable" } });
        });
        throw new AppError("PAYMENT_UNAVAILABLE", { reason: "refund_failed", refundId: prep.refund.id });
      }
    }
    const refund = await withContext(db, scope.db, (tx) => tx.selectFrom("refunds").selectAll().where("id", "=", prep.refund.id).executeTakeFirstOrThrow());
    return reply.status(201).send({ refund: presentRefund(refund) });
  });

  /** Record payment of an invoice (bank transfer, purchase order). */
  app.post("/orders/:orderId/mark-paid", async (request) => {
    const scope = await scopeOf(request);
    const { orderId } = parse(z.object({ orderId: zUuid }).passthrough(), request.params);
    const body = parse(z.object({ reference: z.string().trim().min(1).max(200), reason: zReason }), request.body);
    const now = new Date();
    const order = await withContext(db, scope.db, async (tx) => {
      const o = await loadOrder(tx, scope, orderId, true);
      if (o.payment_method !== "invoice" || o.status !== "pending") throw new AppError("CONFLICT", { reason: "not_an_open_invoice" });
      const u = await tx.updateTable("orders").set({ status: "paid", paid_at: now, external_reference: body.reference }).where("id", "=", orderId).returningAll().executeTakeFirstOrThrow();
      await tx.updateTable("registrations").set({ status: "confirmed", confirmed_at: now, hold_expires_at: null }).where("order_id", "=", orderId).where("status", "=", "pending_payment").execute();
      await audit(tx, request, { ...actor(scope), action: "order.marked_paid", targetType: "order", targetId: orderId, reason: body.reason, before: { status: o.status }, after: { status: "paid", reference: body.reference } });
      return u;
    });
    return { order: presentOrder(order as Order) };
  });

  app.get("/orders/:orderId/receipt", async (request, reply) => {
    const scope = await scopeOf(request);
    const { orderId } = parse(z.object({ orderId: zUuid }).passthrough(), request.params);
    const data = await withContext(db, scope.db, async (tx) => {
      const order = await loadOrder(tx, scope, orderId);
      const lines = await tx.selectFrom("order_lines").select(["description", "total_minor"]).where("order_id", "=", orderId).execute();
      const buyer = await tx.selectFrom("users").select(["display_name", "email"]).where("id", "=", order.buyer_user_id).executeTakeFirst();
      const school = order.school_id ? await tx.selectFrom("schools").select("name").where("id", "=", order.school_id).executeTakeFirst() : null;
      return { order, lines, billedTo: school?.name ?? buyer?.display_name ?? "" };
    });
    return reply.header("content-type", "text/html; charset=utf-8").send(renderReceipt({ locale: request.locale, organizer: scope.tenant.name, billedTo: data.billedTo, order: data.order, lines: data.lines }));
  });

  // ================================================================ reconciliation

  async function importTransactions(tx: Tx, scope: TenantScope, provider: string, txns: z.infer<typeof GatewayTxn>[]) {
    if (!txns.length) return 0;
    const res = await tx
      .insertInto("gateway_transactions")
      .values(txns.map((t) => ({ tenant_id: scope.tenant.id, provider, provider_txn_id: t.providerTxnId, kind: t.kind, provider_ref: t.providerRef, amount_minor: t.amountMinor, fee_minor: t.feeMinor, currency: t.currency, settled_at: t.settledAt, imported_by: scope.auth.userId })))
      .onConflict((oc) => oc.columns(["provider", "provider_txn_id"]).doNothing())
      .returning("id")
      .execute();
    return res.length;
  }

  /** Import a settlement report (e.g. converted from the gateway's CSV). Re-importing is safe. */
  app.post("/payments/gateway-transactions", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const body = parse(z.object({ provider: z.enum(["airwallex", "test"]), transactions: z.array(GatewayTxn).max(10_000) }), request.body);
    const imported = await withContext(db, scope.db, async (tx) => {
      const n = await importTransactions(tx, scope, body.provider, body.transactions);
      await audit(tx, request, { ...actor(scope), action: "reconciliation.imported", targetType: "tenant", targetId: scope.tenant.id, after: { provider: body.provider, received: body.transactions.length, imported: n } });
      return n;
    });
    return { received: body.transactions.length, imported };
  });

  /** Pull settled transactions from the tenant's provider account. */
  app.post("/payments/gateway-transactions/sync", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const body = parse(z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }), request.body);
    const account = await withContext(db, scope.db, (tx) => paymentAccount(tx, scope.tenant.id));
    const provider = providerFor(providers, account.provider);
    let txns;
    try {
      txns = await provider.listSettledTransactions(account.externalAccountId!, new Date(body.from), new Date(body.to));
    } catch (err) {
      request.log.warn({ err }, "settlement sync failed");
      throw new AppError("PAYMENT_UNAVAILABLE", { reason: "provider_error" });
    }
    const imported = await withContext(db, scope.db, (tx) => importTransactions(tx, scope, provider.name, txns));
    return { received: txns.length, imported };
  });

  /** System records ↔ gateway transactions: matched / unsettled / mismatch. */
  app.get("/payments/reconciliation", async (request) => {
    const scope = await scopeOf(request);
    requirePermission(scope, "payments.manage");
    const q = parse(z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), status: z.enum(["matched", "unsettled", "mismatch"]).optional() }), request.query);
    const from = new Date(q.from);
    const to = new Date(q.to);
    return withContext(db, scope.db, async (tx) => {
      const payments = await tx.selectFrom("payments").select(["provider_payment_id", "order_id", "amount_minor", "currency"]).where("status", "=", "succeeded").where("succeeded_at", ">=", from).where("succeeded_at", "<", to).execute();
      const refunds = await tx.selectFrom("refunds").select(["provider_refund_id", "order_id", "amount_minor", "currency"]).where("status", "=", "succeeded").where("provider_refund_id", "is not", null).where("completed_at", ">=", from).where("completed_at", "<", to).execute();
      const system = [
        ...payments.map((p) => ({ kind: "payment" as const, providerRef: p.provider_payment_id, orderId: p.order_id, amountMinor: Number(p.amount_minor), currency: p.currency })),
        ...refunds.map((r) => ({ kind: "refund" as const, providerRef: r.provider_refund_id!, orderId: r.order_id, amountMinor: Number(r.amount_minor), currency: r.currency })),
      ];
      // Settlement lags payment; look a week past the window for our own transactions.
      const refs = system.map((s) => s.providerRef);
      const gw = await tx
        .selectFrom("gateway_transactions")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb("settled_at", ">=", from), eb("settled_at", "<", to)]),
            ...(refs.length ? [eb.and([eb("provider_ref", "in", refs), eb("settled_at", "<", new Date(to.getTime() + 7 * 86_400_000))])] : []),
          ]),
        )
        .execute();
      const rows = reconcile(system, gw.map((g) => ({ kind: g.kind, providerRef: g.provider_ref, amountMinor: Number(g.amount_minor), feeMinor: Number(g.fee_minor), currency: g.currency, settledAt: g.settled_at.toISOString() })));
      const filtered = q.status ? rows.filter((r) => r.status === q.status) : rows;
      return {
        rows: filtered,
        counts: { matched: rows.filter((r) => r.status === "matched").length, unsettled: rows.filter((r) => r.status === "unsettled").length, mismatch: rows.filter((r) => r.status === "mismatch").length },
      };
    });
  });

  /** Gross − gateway fee − platform fee − refunds = tenant net, per currency. */
  app.get("/payments/summary", async (request) => {
    const scope = await scopeOf(request);
    const { competitionId } = parse(z.object({ competitionId: zUuid.optional() }), request.query);
    if (competitionId) needInCompetition(scope, competitionId, "payments.manage");
    else requirePermission(scope, "payments.manage");
    return withContext(db, scope.db, async (tx) => {
      let q = tx.selectFrom("orders").selectAll().where("status", "in", ["paid", "partially_refunded", "refunded"]);
      if (competitionId) q = q.where("competition_id", "=", competitionId);
      const orders = await q.execute();
      const fees = orders.length
        ? await tx.selectFrom("payments").select(["order_id", "gateway_fee_minor"]).where("status", "=", "succeeded").where("order_id", "in", orders.map((o) => o.id)).execute()
        : [];
      const feeByOrder = new Map(fees.map((f) => [f.order_id, Number(f.gateway_fee_minor ?? 0)]));
      const byCurrency = new Map<string, { grossMinor: number; gatewayFeeMinor: number; platformFeeMinor: number; refundedMinor: number; orders: number }>();
      for (const o of orders) {
        const s = byCurrency.get(o.currency) ?? { grossMinor: 0, gatewayFeeMinor: 0, platformFeeMinor: 0, refundedMinor: 0, orders: 0 };
        s.grossMinor += Number(o.total_minor);
        s.gatewayFeeMinor += feeByOrder.get(o.id) ?? 0;
        s.platformFeeMinor += Number(o.platform_fee_minor);
        s.refundedMinor += Number(o.refunded_minor);
        s.orders += 1;
        byCurrency.set(o.currency, s);
      }
      return { currencies: [...byCurrency.entries()].map(([currency, s]) => ({ currency, ...s, tenantNetMinor: tenantNet(s) })) };
    });
  });
}
