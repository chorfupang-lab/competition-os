import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import {
  AppError,
  checkTranslation,
  gradeResponse,
  localizeItem,
  parseContentItem,
  type ContentItemData,
  type Response as ItemResponse,
  type TranslationStrings,
} from "@cos/core";
import { withContext, type ContentBank, type Tx } from "@cos/db";
import { audit } from "../lib/audit.ts";
import {
  checkRefs,
  currentTranslations,
  dataToRow,
  itemHash,
  loadBankRefs,
  presentBank,
  presentItem,
  rowToData,
  rowToInput,
  translationState,
} from "../lib/content.ts";
import { planImport, type ImportPlan } from "../lib/content-import.ts";
import { buildTemplate, parseWorkbook, type ParsedWorkbook } from "../lib/excel.ts";
import { newId } from "../lib/crypto.ts";
import { requirePermission, resolveTenantScope, type TenantScope } from "../lib/tenant-scope.ts";
import { parse, zI18n, zLocale, zReason, zUuid } from "../lib/validation.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const zKey = z.string().trim().toLowerCase().pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/));
const zSkillKey = z.string().trim().toLowerCase().pipe(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,59}$/));

const FrameworkBody = z.object({ key: zKey, name: z.string().trim().min(1).max(200), nameI18n: zI18n.optional() });
const SkillBody = z.object({
  key: zSkillKey,
  name: z.string().trim().min(1).max(200),
  nameI18n: zI18n.optional(),
  descriptionI18n: z.partialRecord(zLocale, z.string().max(2000)).optional(),
  parentId: zUuid.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
const SkillPatch = SkillBody.omit({ key: true, parentId: true }).partial().extend({ status: z.enum(["active", "archived"]).optional() });

const BankBody = z.object({
  key: zKey,
  name: z.string().trim().min(1).max(200),
  nameI18n: zI18n.optional(),
  descriptionI18n: z.partialRecord(zLocale, z.string().max(5000)).optional(),
  baseLocale: zLocale,
  requiredLocales: z.array(zLocale).max(4).optional(),
  skillFrameworkId: zUuid.nullable().optional(),
  /** Allow this bank's published questions in student practice sets (never for banks used in upcoming competitions). */
  practiceEnabled: z.boolean().optional(),
});
const BankPatch = BankBody.omit({ key: true, baseLocale: true }).partial().extend({ status: z.enum(["active", "archived"]).optional() });
const ObjectiveBody = z.object({ key: zSkillKey, title: z.string().trim().min(1).max(500), titleI18n: zI18n.optional(), skillIds: z.array(zUuid).max(20).optional() });

const ItemStatus = z.enum(["draft", "ready"]);
const TranslationBody = z.object({ strings: z.record(z.string().max(200), z.string().max(5000)), status: z.enum(["draft", "approved"]).default("draft") });

const Paging = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });

export async function contentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.addContentTypeParser([XLSX_MIME, "application/octet-stream"], { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  async function scope(request: FastifyRequest, mode: "read" | "manage"): Promise<TenantScope> {
    const { tenantId } = parse(z.object({ tenantId: zUuid }).passthrough(), request.params);
    const s = await resolveTenantScope(db, request, tenantId);
    if (mode === "manage") requirePermission(s, "content.manage");
    else if (!s.permissions.has("content.read") && !s.permissions.has("content.manage")) throw new AppError("FORBIDDEN");
    return s;
  }
  const bankIdOf = (request: FastifyRequest) => parse(z.object({ bankId: zUuid }).passthrough(), request.params).bankId;

  async function loadBank(tx: Tx, s: TenantScope, bankId: string, forUpdate = false): Promise<ContentBank> {
    let q = tx.selectFrom("content_banks").selectAll().where("id", "=", bankId).where("tenant_id", "=", s.tenant.id);
    if (forUpdate) q = q.forUpdate();
    const bank = await q.executeTakeFirst();
    if (!bank) throw new AppError("NOT_FOUND");
    return bank;
  }
  const writable = (bank: ContentBank) => {
    if (bank.status !== "active") throw new AppError("CONFLICT", { reason: "bank_archived" });
  };
  const auditCtx = (s: TenantScope) => ({ tenantId: s.tenant.id, actorUserId: s.auth.userId });

  // ================================================================ skill frameworks

  app.get("/skill-frameworks", async (request) => {
    const s = await scope(request, "read");
    const rows = await withContext(db, s.db, (tx) => tx.selectFrom("skill_frameworks").selectAll().orderBy("name").execute());
    return { frameworks: rows.map((f) => ({ id: f.id, key: f.key, name: f.name, nameI18n: f.name_i18n, status: f.status })) };
  });

  app.post("/skill-frameworks", async (request, reply) => {
    const s = await scope(request, "manage");
    const body = parse(FrameworkBody, request.body);
    const f = await withContext(db, s.db, async (tx) => {
      const f = await tx
        .insertInto("skill_frameworks")
        .values({ tenant_id: s.tenant.id, key: body.key, name: body.name, name_i18n: JSON.stringify(body.nameI18n ?? {}), created_by: s.auth.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.skill_framework_created", targetType: "skill_framework", targetId: f.id, after: { key: f.key, name: f.name } });
      return f;
    });
    return reply.status(201).send({ framework: { id: f.id, key: f.key, name: f.name } });
  });

  app.get("/skill-frameworks/:frameworkId", async (request) => {
    const s = await scope(request, "read");
    const { frameworkId } = parse(z.object({ frameworkId: zUuid }).passthrough(), request.params);
    return withContext(db, s.db, async (tx) => {
      const f = await tx.selectFrom("skill_frameworks").selectAll().where("id", "=", frameworkId).executeTakeFirst();
      if (!f) throw new AppError("NOT_FOUND");
      const skills = await tx.selectFrom("skills").selectAll().where("framework_id", "=", frameworkId).orderBy("sort_order").orderBy("key").execute();
      return {
        framework: { id: f.id, key: f.key, name: f.name, nameI18n: f.name_i18n, status: f.status },
        skills: skills.map((k) => ({ id: k.id, key: k.key, name: k.name, nameI18n: k.name_i18n, descriptionI18n: k.description_i18n, parentId: k.parent_id, sortOrder: k.sort_order, status: k.status })),
      };
    });
  });

  app.post("/skill-frameworks/:frameworkId/skills", async (request, reply) => {
    const s = await scope(request, "manage");
    const { frameworkId } = parse(z.object({ frameworkId: zUuid }).passthrough(), request.params);
    const body = parse(SkillBody, request.body);
    const skill = await withContext(db, s.db, async (tx) => {
      const f = await tx.selectFrom("skill_frameworks").select("id").where("id", "=", frameworkId).executeTakeFirst();
      if (!f) throw new AppError("NOT_FOUND");
      if (body.parentId) {
        const parent = await tx.selectFrom("skills").select("id").where("id", "=", body.parentId).where("framework_id", "=", frameworkId).executeTakeFirst();
        if (!parent) throw new AppError("NOT_FOUND", { field: "parentId" });
      }
      const k = await tx
        .insertInto("skills")
        .values({
          tenant_id: s.tenant.id,
          framework_id: frameworkId,
          parent_id: body.parentId ?? null,
          key: body.key,
          name: body.name,
          name_i18n: JSON.stringify(body.nameI18n ?? {}),
          description_i18n: JSON.stringify(body.descriptionI18n ?? {}),
          ...(body.sortOrder !== undefined && { sort_order: body.sortOrder }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.skill_created", targetType: "skill", targetId: k.id, after: { key: k.key, frameworkId, parentId: k.parent_id } });
      return k;
    });
    return reply.status(201).send({ skill: { id: skill.id, key: skill.key, name: skill.name, parentId: skill.parent_id } });
  });

  app.patch("/skill-frameworks/:frameworkId/skills/:skillId", async (request) => {
    const s = await scope(request, "manage");
    const { frameworkId, skillId } = parse(z.object({ frameworkId: zUuid, skillId: zUuid }).passthrough(), request.params);
    const body = parse(SkillPatch, request.body);
    await withContext(db, s.db, async (tx) => {
      const before = await tx.selectFrom("skills").selectAll().where("id", "=", skillId).where("framework_id", "=", frameworkId).executeTakeFirst();
      if (!before) throw new AppError("NOT_FOUND");
      const changes = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.nameI18n !== undefined && { name_i18n: JSON.stringify(body.nameI18n) }),
        ...(body.descriptionI18n !== undefined && { description_i18n: JSON.stringify(body.descriptionI18n) }),
        ...(body.sortOrder !== undefined && { sort_order: body.sortOrder }),
        ...(body.status !== undefined && { status: body.status }),
      };
      if (Object.keys(changes).length === 0) return;
      await tx.updateTable("skills").set(changes).where("id", "=", skillId).execute();
      await audit(tx, request, { ...auditCtx(s), action: "content.skill_updated", targetType: "skill", targetId: skillId, before: { name: before.name, status: before.status }, after: body });
    });
    return { ok: true };
  });

  // ================================================================ banks

  app.get("/banks", async (request) => {
    const s = await scope(request, "read");
    const rows = await withContext(db, s.db, (tx) => tx.selectFrom("content_banks").selectAll().orderBy("name").execute());
    return { banks: rows.map(presentBank) };
  });

  app.post("/banks", async (request, reply) => {
    const s = await scope(request, "manage");
    const body = parse(BankBody, request.body);
    const bank = await withContext(db, s.db, async (tx) => {
      if (body.skillFrameworkId) {
        const f = await tx.selectFrom("skill_frameworks").select("id").where("id", "=", body.skillFrameworkId).executeTakeFirst();
        if (!f) throw new AppError("NOT_FOUND", { field: "skillFrameworkId" });
      }
      const b = await tx
        .insertInto("content_banks")
        .values({
          tenant_id: s.tenant.id,
          key: body.key,
          name: body.name,
          name_i18n: JSON.stringify(body.nameI18n ?? {}),
          description_i18n: JSON.stringify(body.descriptionI18n ?? {}),
          base_locale: body.baseLocale,
          required_locales: [...new Set(body.requiredLocales ?? [])].filter((l) => l !== body.baseLocale),
          skill_framework_id: body.skillFrameworkId ?? null,
          ...(body.practiceEnabled !== undefined && { practice_enabled: body.practiceEnabled }),
          created_by: s.auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.bank_created", targetType: "content_bank", targetId: b.id, after: presentBank(b) });
      return b;
    });
    return reply.status(201).send({ bank: presentBank(bank) });
  });

  app.get("/banks/:bankId", async (request) => {
    const s = await scope(request, "read");
    const bankId = bankIdOf(request);
    return withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId);
      const counts = await tx
        .selectFrom("content_items")
        .select(["status", (eb) => eb.fn.countAll<string>().as("n")])
        .where("bank_id", "=", bankId)
        .groupBy("status")
        .execute();
      const versions = await tx.selectFrom("content_bank_versions").selectAll().where("bank_id", "=", bankId).orderBy("version_number", "desc").execute();
      return {
        bank: presentBank(bank),
        itemCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
        versions: versions.map(presentContentVersion),
      };
    });
  });

  app.patch("/banks/:bankId", async (request) => {
    const s = await scope(request, "manage");
    const bankId = bankIdOf(request);
    const body = parse(BankPatch, request.body);
    const bank = await withContext(db, s.db, async (tx) => {
      const before = await loadBank(tx, s, bankId, true);
      if (body.skillFrameworkId !== undefined && body.skillFrameworkId !== before.skill_framework_id) {
        // Items' skill mappings belong to the old framework; changing it would orphan them.
        const mapped = await tx.selectFrom("content_items").select("id").where("bank_id", "=", bankId).where(sql<boolean>`cardinality(skill_ids) > 0`).executeTakeFirst();
        if (mapped) throw new AppError("CONFLICT", { reason: "items_mapped_to_skills" });
        if (body.skillFrameworkId) {
          const f = await tx.selectFrom("skill_frameworks").select("id").where("id", "=", body.skillFrameworkId).executeTakeFirst();
          if (!f) throw new AppError("NOT_FOUND", { field: "skillFrameworkId" });
        }
      }
      const changes = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.nameI18n !== undefined && { name_i18n: JSON.stringify(body.nameI18n) }),
        ...(body.descriptionI18n !== undefined && { description_i18n: JSON.stringify(body.descriptionI18n) }),
        ...(body.requiredLocales !== undefined && { required_locales: [...new Set(body.requiredLocales)].filter((l) => l !== before.base_locale) }),
        ...(body.skillFrameworkId !== undefined && { skill_framework_id: body.skillFrameworkId }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.practiceEnabled !== undefined && { practice_enabled: body.practiceEnabled }),
      };
      if (Object.keys(changes).length === 0) return before;
      const after = await tx.updateTable("content_banks").set(changes).where("id", "=", bankId).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.bank_updated", targetType: "content_bank", targetId: bankId, before: presentBank(before), after: presentBank(after) });
      return after;
    });
    return { bank: presentBank(bank) };
  });

  // ================================================================ learning objectives

  app.get("/banks/:bankId/objectives", async (request) => {
    const s = await scope(request, "read");
    const bankId = bankIdOf(request);
    const rows = await withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      return tx.selectFrom("learning_objectives").selectAll().where("bank_id", "=", bankId).orderBy("key").execute();
    });
    return { objectives: rows.map((o) => ({ id: o.id, key: o.key, title: o.title, titleI18n: o.title_i18n, skillIds: o.skill_ids, status: o.status })) };
  });

  app.post("/banks/:bankId/objectives", async (request, reply) => {
    const s = await scope(request, "manage");
    const bankId = bankIdOf(request);
    const body = parse(ObjectiveBody, request.body);
    const o = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId);
      writable(bank);
      const refs = await loadBankRefs(tx, bank);
      const issues = checkRefs({ skillIds: body.skillIds ?? [], objectiveIds: [] }, refs);
      if (issues.length) throw new AppError("VALIDATION_FAILED", issues);
      const o = await tx
        .insertInto("learning_objectives")
        .values({ tenant_id: s.tenant.id, bank_id: bankId, key: body.key, title: body.title, title_i18n: JSON.stringify(body.titleI18n ?? {}), skill_ids: [...new Set(body.skillIds ?? [])] })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.objective_created", targetType: "learning_objective", targetId: o.id, after: { key: o.key, bankId } });
      return o;
    });
    return reply.status(201).send({ objective: { id: o.id, key: o.key, title: o.title, skillIds: o.skill_ids } });
  });

  // ================================================================ items

  app.get("/banks/:bankId/items", async (request) => {
    const s = await scope(request, "read");
    const bankId = bankIdOf(request);
    const q = parse(
      Paging.extend({
        status: z.enum(["draft", "ready", "retired"]).optional(),
        contentType: z.string().max(40).optional(),
        difficulty: z.enum(["easy", "medium", "hard", "expert"]).optional(),
        q: z.string().trim().max(200).optional(),
      }),
      request.query,
    );
    return withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      let query = tx.selectFrom("content_items").selectAll().where("bank_id", "=", bankId);
      if (q.status) query = query.where("status", "=", q.status);
      if (q.contentType) query = query.where("content_type", "=", q.contentType);
      if (q.difficulty) query = query.where("difficulty", "=", q.difficulty);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query = query.where((eb) => eb.or([eb("external_key", "ilike", like), eb(sql<string>`body->>'prompt'`, "ilike", like)]));
      }
      const rows = await query.orderBy("external_key").limit(q.limit).offset(q.offset).execute();
      const translations = rows.length
        ? await tx.selectFrom("content_item_translations").selectAll().where("item_id", "in", rows.map((r) => r.id)).execute()
        : [];
      return { items: rows.map((r) => presentItem(r, translations)) };
    });
  });

  app.post("/banks/:bankId/items", async (request, reply) => {
    const s = await scope(request, "manage");
    const bankId = bankIdOf(request);
    const body = parse(z.object({ status: ItemStatus.default("draft") }).passthrough(), request.body);
    const result = parseContentItem(request.body);
    if (!result.ok) throw new AppError("VALIDATION_FAILED", result.issues);
    const row = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId);
      writable(bank);
      const issues = checkRefs(result.item, await loadBankRefs(tx, bank));
      if (issues.length) throw new AppError("VALIDATION_FAILED", issues);
      const r = await tx
        .insertInto("content_items")
        .values({ tenant_id: s.tenant.id, bank_id: bankId, ...dataToRow(result.item), status: body.status, created_by: s.auth.userId, updated_by: s.auth.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.item_created", targetType: "content_item", targetId: r.id, after: { externalKey: r.external_key, contentType: r.content_type, status: r.status } });
      return r;
    });
    return reply.status(201).send({ item: presentItem(row) });
  });

  const itemParams = (request: FastifyRequest) => parse(z.object({ bankId: zUuid, itemId: zUuid }).passthrough(), request.params);
  async function loadItem(tx: Tx, bankId: string, itemId: string, forUpdate = false) {
    let q = tx.selectFrom("content_items").selectAll().where("id", "=", itemId).where("bank_id", "=", bankId);
    if (forUpdate) q = q.forUpdate();
    const item = await q.executeTakeFirst();
    if (!item) throw new AppError("NOT_FOUND");
    return item;
  }

  app.get("/banks/:bankId/items/:itemId", async (request) => {
    const s = await scope(request, "read");
    const { bankId, itemId } = itemParams(request);
    return withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      const row = await loadItem(tx, bankId, itemId);
      const translations = await tx.selectFrom("content_item_translations").selectAll().where("item_id", "=", itemId).execute();
      return {
        item: presentItem(row, translations),
        translationStrings: Object.fromEntries(translations.map((t) => [t.locale, t.strings])),
      };
    });
  });

  /** Replace an item. Send back the revision you edited; edits to an outdated revision are refused. */
  app.put("/banks/:bankId/items/:itemId", async (request) => {
    const s = await scope(request, "manage");
    const { bankId, itemId } = itemParams(request);
    const meta = parse(z.object({ revision: z.number().int().min(1), status: ItemStatus.optional() }).passthrough(), request.body);
    const result = parseContentItem(request.body);
    if (!result.ok) throw new AppError("VALIDATION_FAILED", result.issues);
    const row = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId);
      writable(bank);
      const before = await loadItem(tx, bankId, itemId, true);
      if (before.revision !== meta.revision) throw new AppError("CONFLICT", { reason: "stale_revision", currentRevision: before.revision });
      if (before.content_type !== result.item.contentType) throw new AppError("CONFLICT", { reason: "content_type_change", hint: "Create a new item instead" });
      if (before.status === "retired") throw new AppError("CONFLICT", { reason: "item_retired" });
      const issues = checkRefs(result.item, await loadBankRefs(tx, bank));
      if (issues.length) throw new AppError("VALIDATION_FAILED", issues);
      const r = await tx
        .updateTable("content_items")
        .set({ ...dataToRow(result.item), ...(meta.status && { status: meta.status }), revision: before.revision + 1, updated_by: s.auth.userId })
        .where("id", "=", itemId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        ...auditCtx(s),
        action: "content.item_updated",
        targetType: "content_item",
        targetId: itemId,
        before: { revision: before.revision, ...rowToData(before) },
        after: { revision: r.revision, ...result.item },
      });
      return r;
    });
    const translations = await withContext(db, s.db, (tx) => tx.selectFrom("content_item_translations").selectAll().where("item_id", "=", itemId).execute());
    return { item: presentItem(row, translations) };
  });

  /** draft ↔ ready, or retire (reason required). Retired items are kept for history and old versions. */
  app.post("/banks/:bankId/items/:itemId/status", async (request) => {
    const s = await scope(request, "manage");
    const { bankId, itemId } = itemParams(request);
    const body = parse(z.object({ status: z.enum(["draft", "ready", "retired"]), reason: z.string().trim().max(2000).optional() }), request.body);
    if (body.status === "retired" && (body.reason ?? "").length < 3) throw new AppError("REASON_REQUIRED");
    const row = await withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      const before = await loadItem(tx, bankId, itemId, true);
      if (before.status === "retired") throw new AppError("CONFLICT", { reason: "item_retired" });
      const r = await tx.updateTable("content_items").set({ status: body.status, updated_by: s.auth.userId }).where("id", "=", itemId).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, { ...auditCtx(s), action: "content.item_status_changed", targetType: "content_item", targetId: itemId, reason: body.reason ?? null, before: { status: before.status }, after: { status: body.status } });
      return r;
    });
    return { item: presentItem(row) };
  });

  app.put("/banks/:bankId/items/:itemId/translations/:locale", async (request) => {
    const s = await scope(request, "manage");
    const { bankId, itemId } = itemParams(request);
    const { locale } = parse(z.object({ locale: zLocale }).passthrough(), request.params);
    const body = parse(TranslationBody, request.body);
    const state = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId);
      writable(bank);
      const row = await loadItem(tx, bankId, itemId);
      const item = rowToData(row);
      if (locale === item.baseLocale) throw new AppError("VALIDATION_FAILED", [{ path: "locale", message: "This is the item's base language" }]);
      const strings = Object.fromEntries(Object.entries(body.strings).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      const check = checkTranslation(item, strings);
      if (check.unknownPaths.length) throw new AppError("VALIDATION_FAILED", check.unknownPaths.map((p) => ({ path: `strings.${p}`, message: "Not a text of this item" })));
      if (body.status === "approved" && check.missingPaths.length) {
        throw new AppError("VALIDATION_FAILED", check.missingPaths.map((p) => ({ path: `strings.${p}`, message: "Required before approval" })));
      }
      const values = {
        strings: JSON.stringify(strings),
        source_hash: itemHash(item),
        status: body.status,
        updated_by: s.auth.userId,
        approved_by: body.status === "approved" ? s.auth.userId : null,
        approved_at: body.status === "approved" ? new Date() : null,
      };
      const existing = await tx.selectFrom("content_item_translations").select(["id", "status"]).where("item_id", "=", itemId).where("locale", "=", locale).executeTakeFirst();
      const t = existing
        ? await tx.updateTable("content_item_translations").set(values).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow()
        : await tx.insertInto("content_item_translations").values({ tenant_id: s.tenant.id, item_id: itemId, locale, ...values }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, {
        ...auditCtx(s),
        action: "content.translation_saved",
        targetType: "content_item",
        targetId: itemId,
        before: existing ? { status: existing.status } : null,
        after: { locale, status: body.status },
      });
      return translationState(item, t);
    });
    return { translation: state };
  });

  /** Author preview: the item in one locale (answers included; this is the admin view). */
  app.get("/banks/:bankId/items/:itemId/preview", async (request) => {
    const s = await scope(request, "read");
    const { bankId, itemId } = itemParams(request);
    const { locale } = parse(z.object({ locale: zLocale.optional() }), request.query);
    return withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      const item = rowToData(await loadItem(tx, bankId, itemId));
      if (!locale || locale === item.baseLocale) return { locale: item.baseLocale, translation: null, item };
      const t = await tx.selectFrom("content_item_translations").selectAll().where("item_id", "=", itemId).where("locale", "=", locale).executeTakeFirst();
      return {
        locale,
        translation: t ? translationState(item, t) : null,
        item: localizeItem(item, t ? (t.strings as TranslationStrings) : null),
      };
    });
  });

  /** Try an answer against an item, as the runtime will grade it. */
  app.post("/banks/:bankId/items/:itemId/grade", async (request) => {
    const s = await scope(request, "read");
    const { bankId, itemId } = itemParams(request);
    const body = parse(z.object({ response: z.record(z.string(), z.unknown()).nullable() }), request.body);
    const item = await withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      return rowToData(await loadItem(tx, bankId, itemId));
    });
    return { grade: gradeResponse(item, body.response as ItemResponse | null) };
  });

  // ================================================================ Excel import

  app.get("/banks/:bankId/import-template", async (request, reply) => {
    const s = await scope(request, "read");
    const bank = await withContext(db, s.db, (tx) => loadBank(tx, s, bankIdOf(request)));
    const file = await buildTemplate({ baseLocale: bank.base_locale, requiredLocales: bank.required_locales });
    return reply
      .header("content-type", XLSX_MIME)
      .header("content-disposition", `attachment; filename="${bank.key}-import-template.xlsx"`)
      .send(file);
  });

  /** Upload an .xlsx (raw body). Validates and returns a preview; nothing changes until commit. */
  app.post("/banks/:bankId/imports", { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const s = await scope(request, "manage");
    const bankId = bankIdOf(request);
    if (!Buffer.isBuffer(request.body)) throw new AppError("VALIDATION_FAILED", [{ path: "body", message: `Send the file as ${XLSX_MIME}` }]);
    const filename = String(request.headers["x-filename"] ?? "upload.xlsx").slice(0, 200);
    const result = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId);
      writable(bank);
      const parsed = await parseWorkbook(request.body as Buffer, { baseLocale: bank.base_locale });
      const plan = await planImport(tx, bank, parsed);
      const status = plan.errors.length ? "rejected" : "validated";
      const id = newId();
      await tx
        .insertInto("content_imports")
        .values({
          id,
          tenant_id: s.tenant.id,
          bank_id: bankId,
          filename,
          status,
          row_count: parsed.items.length + parsed.translations.length,
          rows: JSON.stringify(parsed),
          errors: JSON.stringify(plan.errors),
          summary: JSON.stringify(plan.summary),
          created_by: s.auth.userId,
          committed_by: null,
        })
        .execute();
      await audit(tx, request, { ...auditCtx(s), action: "content.import_uploaded", targetType: "content_import", targetId: id, after: { filename, status, ...plan.summary } });
      return { id, status, plan };
    });
    return reply.status(201).send(presentImport(result.id, result.status, result.plan));
  });

  app.get("/banks/:bankId/imports/:importId", async (request) => {
    const s = await scope(request, "read");
    const { bankId, importId } = parse(z.object({ bankId: zUuid, importId: zUuid }).passthrough(), request.params);
    const row = await withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      return tx.selectFrom("content_imports").selectAll().where("id", "=", importId).where("bank_id", "=", bankId).executeTakeFirst();
    });
    if (!row) throw new AppError("NOT_FOUND");
    return { id: row.id, filename: row.filename, status: row.status, summary: row.summary, errors: row.errors, createdAt: row.created_at, committedAt: row.committed_at };
  });

  /** Apply a validated import. It is re-validated against the bank as it is now. */
  app.post("/banks/:bankId/imports/:importId/commit", async (request) => {
    const s = await scope(request, "manage");
    const { bankId, importId } = parse(z.object({ bankId: zUuid, importId: zUuid }).passthrough(), request.params);
    const result = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId, true);
      writable(bank);
      const imp = await tx.selectFrom("content_imports").selectAll().where("id", "=", importId).where("bank_id", "=", bankId).forUpdate().executeTakeFirst();
      if (!imp) throw new AppError("NOT_FOUND");
      if (imp.status !== "validated") throw new AppError("CONFLICT", { reason: `import_${imp.status}` });
      const plan = await planImport(tx, bank, imp.rows as ParsedWorkbook);
      if (plan.errors.length) throw new AppError("CONFLICT", { reason: "import_no_longer_valid", errors: plan.errors.slice(0, 200) });

      const ids = new Map<string, string>();
      for (const p of plan.items) {
        if (p.action === "create") {
          const id = newId();
          await tx
            .insertInto("content_items")
            .values({ id, tenant_id: s.tenant.id, bank_id: bankId, ...dataToRow(p.item), status: p.status, created_by: s.auth.userId, updated_by: s.auth.userId })
            .execute();
          ids.set(p.item.externalKey.toLowerCase(), id);
        } else {
          ids.set(p.item.externalKey.toLowerCase(), p.existingId!);
          if (p.action === "update") {
            await tx
              .updateTable("content_items")
              .set((eb) => ({ ...dataToRow(p.item), status: p.status, revision: eb("revision", "+", 1), updated_by: s.auth.userId }))
              .where("id", "=", p.existingId!)
              .execute();
          }
        }
      }
      const byKey = new Map(
        (await tx.selectFrom("content_items").select(["id", "external_key"]).where("bank_id", "=", bankId).execute()).map((r) => [r.external_key.toLowerCase(), r.id]),
      );
      const items = new Map(plan.items.map((p) => [p.item.externalKey.toLowerCase(), p.item]));
      for (const t of plan.translations) {
        const itemId = ids.get(t.externalKey.toLowerCase()) ?? byKey.get(t.externalKey.toLowerCase())!;
        const item = items.get(t.externalKey.toLowerCase()) ?? rowToData(await loadItem(tx, bankId, itemId));
        const values = {
          strings: JSON.stringify(t.strings),
          source_hash: itemHash(item),
          status: t.status,
          updated_by: s.auth.userId,
          approved_by: t.status === "approved" ? s.auth.userId : null,
          approved_at: t.status === "approved" ? new Date() : null,
        };
        const existing = await tx.selectFrom("content_item_translations").select("id").where("item_id", "=", itemId).where("locale", "=", t.locale).executeTakeFirst();
        if (existing) await tx.updateTable("content_item_translations").set(values).where("id", "=", existing.id).execute();
        else await tx.insertInto("content_item_translations").values({ tenant_id: s.tenant.id, item_id: itemId, locale: t.locale, ...values }).execute();
      }
      await tx.updateTable("content_imports").set({ status: "committed", committed_by: s.auth.userId, committed_at: new Date(), summary: JSON.stringify(plan.summary) }).where("id", "=", importId).execute();
      await audit(tx, request, { ...auditCtx(s), action: "content.import_committed", targetType: "content_import", targetId: importId, after: plan.summary });
      return plan;
    });
    return { id: importId, status: "committed", summary: result.summary };
  });

  // ================================================================ versions

  /**
   * Publish the bank's "ready" items as a new immutable Content Bank Version.
   * Every item is re-validated; required locales need an approved translation
   * that matches the current text. Competitions then reference the version id.
   */
  app.post("/banks/:bankId/versions", async (request, reply) => {
    const s = await scope(request, "manage");
    const bankId = bankIdOf(request);
    const { note } = parse(z.object({ note: z.string().trim().max(2000).optional() }), request.body);
    const version = await withContext(db, s.db, async (tx) => {
      const bank = await loadBank(tx, s, bankId, true);
      writable(bank);
      const rows = await tx.selectFrom("content_items").selectAll().where("bank_id", "=", bankId).where("status", "=", "ready").orderBy("external_key").execute();
      if (rows.length === 0) throw new AppError("CONFLICT", { reason: "no_ready_items" });
      const refs = await loadBankRefs(tx, bank);
      const translations = await tx.selectFrom("content_item_translations").selectAll().where("item_id", "in", rows.map((r) => r.id)).execute();

      const problems: Array<{ externalKey: string; issues: { path: string; message: string }[] }> = [];
      const snapshots: Array<{ row: (typeof rows)[number]; item: ContentItemData; locales: string[]; translations: Record<string, TranslationStrings> }> = [];
      for (const row of rows) {
        const parsed = parseContentItem(rowToInput(row));
        if (!parsed.ok) {
          problems.push({ externalKey: row.external_key, issues: parsed.issues });
          continue;
        }
        const issues = checkRefs(parsed.item, refs);
        const current = currentTranslations(parsed.item, translations.filter((t) => t.item_id === row.id));
        for (const locale of bank.required_locales) {
          if (locale !== parsed.item.baseLocale && !current[locale]) {
            issues.push({ path: `translations.${locale}`, message: `No approved ${locale} translation for the current text` });
          }
        }
        if (issues.length) problems.push({ externalKey: row.external_key, issues });
        else snapshots.push({ row, item: parsed.item, locales: [parsed.item.baseLocale, ...Object.keys(current)].sort(), translations: current });
      }
      if (problems.length) throw new AppError("CONFLICT", { reason: "items_have_errors", items: problems.slice(0, 200), total: problems.length });

      const { max } = await tx
        .selectFrom("content_bank_versions")
        .select((eb) => eb.fn.max("version_number").as("max"))
        .where("bank_id", "=", bankId)
        .executeTakeFirstOrThrow();
      const count = (f: (x: (typeof snapshots)[number]) => string[]) =>
        snapshots.reduce<Record<string, number>>((acc, x) => {
          for (const k of f(x)) acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
      const summary = {
        byType: count((x) => [x.item.contentType]),
        byDifficulty: count((x) => [x.item.difficulty]),
        byLocale: count((x) => x.locales),
      };
      const v = await tx
        .insertInto("content_bank_versions")
        .values({ tenant_id: s.tenant.id, bank_id: bankId, version_number: Number(max ?? 0) + 1, item_count: snapshots.length, summary: JSON.stringify(summary), note: note ?? null, published_by: s.auth.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      const keyOf = (m: Map<string, { key: string }>, ids: string[]) => ids.map((id) => ({ id, key: m.get(id)!.key }));
      for (let i = 0; i < snapshots.length; i += 500) {
        await tx
          .insertInto("content_version_items")
          .values(
            snapshots.slice(i, i + 500).map((x) => ({
              tenant_id: s.tenant.id,
              version_id: v.id,
              item_id: x.row.id,
              external_key: x.item.externalKey,
              content_type: x.item.contentType,
              difficulty: x.item.difficulty,
              category: x.item.category,
              tags: x.item.tags,
              locales: x.locales,
              snapshot: JSON.stringify({
                item: { id: x.row.id, revision: x.row.revision, ...x.item },
                translations: x.translations,
                skills: keyOf(refs.skills, x.item.skillIds),
                objectives: keyOf(refs.objectives, x.item.objectiveIds),
              }),
            })),
          )
          .execute();
      }
      await audit(tx, request, { ...auditCtx(s), action: "content.version_published", targetType: "content_bank_version", targetId: v.id, reason: note ?? null, after: { bankId, versionNumber: v.version_number, itemCount: v.item_count, summary } });
      return v;
    });
    return reply.status(201).send({ version: presentContentVersion(version) });
  });

  app.get("/banks/:bankId/versions/:versionId/items", async (request) => {
    const s = await scope(request, "read");
    const { bankId, versionId } = parse(z.object({ bankId: zUuid, versionId: zUuid }).passthrough(), request.params);
    const page = parse(Paging, request.query);
    return withContext(db, s.db, async (tx) => {
      await loadBank(tx, s, bankId);
      const v = await tx.selectFrom("content_bank_versions").selectAll().where("id", "=", versionId).where("bank_id", "=", bankId).executeTakeFirst();
      if (!v) throw new AppError("NOT_FOUND");
      const items = await tx.selectFrom("content_version_items").select(["snapshot", "locales"]).where("version_id", "=", versionId).orderBy("external_key").limit(page.limit).offset(page.offset).execute();
      return { version: presentContentVersion(v), items: items.map((i) => ({ ...(i.snapshot as object), locales: i.locales })) };
    });
  });
}

function presentContentVersion(v: { id: string; bank_id: string; version_number: number; item_count: number; summary: unknown; note: string | null; published_by: string | null; published_at: Date }) {
  return { id: v.id, bankId: v.bank_id, versionNumber: v.version_number, itemCount: v.item_count, summary: v.summary, note: v.note, publishedBy: v.published_by, publishedAt: v.published_at };
}

function presentImport(id: string, status: string, plan: ImportPlan) {
  return {
    id,
    status,
    summary: plan.summary,
    errors: plan.errors.slice(0, 500),
    preview: plan.items.slice(0, 50).map((p) => ({ action: p.action, status: p.status, externalKey: p.item.externalKey, contentType: p.item.contentType, prompt: (p.item.body as { prompt: string }).prompt })),
  };
}
