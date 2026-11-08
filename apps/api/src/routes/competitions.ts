import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AppError,
  COMPETITION_SCOPED_PERMISSIONS,
  CompetitionConfigSchema,
  QualificationError,
  diffConfigs,
  eligibleGroups,
  evaluateQualification,
  hasErrors,
  rankByScope,
  rankParticipants,
  standardTemplate,
  validateConfig,
  validateContentReferences,
  type CompetitionConfig,
  type ConfigIssue,
  type VersionItemSummary,
} from "@cos/core";
import { withContext, type Competition, type CompetitionVersion, type Tx } from "@cos/db";
import { audit } from "../lib/audit.ts";
import { presentCompetition, presentVersion, presentVersionSummary } from "../lib/present.ts";
import {
  permissionsInCompetition,
  requireCompetitionPermission,
  requirePermission,
  resolveTenantScope,
  type TenantScope,
} from "../lib/tenant-scope.ts";
import { parse, zDate, zI18n, zLocale, zReason, zUuid } from "../lib/validation.ts";

const zTimezone = z.string().min(1).max(64).refine(isTimezone, "unknown IANA timezone");
const zLocales = z.array(zLocale).min(1).max(10).transform((l) => [...new Set(l)]);

const CreateBody = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    name: z.string().trim().min(1).max(300),
    nameI18n: zI18n.optional(),
    descriptionI18n: z.partialRecord(zLocale, z.string().max(10_000)).optional(),
    feeMode: z.enum(["free", "paid"]),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    timezone: zTimezone.optional(),
    visibility: z.enum(["public", "unlisted", "private"]).optional(),
    interfaceLocales: zLocales.optional(),
    contentLocales: zLocales.optional(),
    /** Initial configuration; defaults to the standard template. */
    config: z.unknown().optional(),
  });

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  nameI18n: zI18n.optional(),
  descriptionI18n: z.partialRecord(zLocale, z.string().max(10_000)).optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  interfaceLocales: zLocales.optional(),
  contentLocales: zLocales.optional(),
  // Locked once the competition has been published:
  feeMode: z.enum(["free", "paid"]).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  timezone: zTimezone.optional(),
});

const SaveConfigBody = z.object({ revision: z.number().int().min(1), config: z.unknown() });
const PublishBody = z.object({ note: z.string().trim().max(2000).optional() });

const SimulateParticipant = z.object({
  participantId: z.string().min(1).max(100),
  totalScore: z.number(),
  accuracy: z.number().min(0).max(1),
  timeMs: z.number().int().min(0),
  hardQuestionScore: z.number().default(0),
  submittedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["ok", "disqualified", "invalidated"]).default("ok"),
  scopes: z.partialRecord(z.enum(["school", "country", "region", "class", "team"]), z.string().max(100)).optional(),
});
const SimulateBody = z.object({
  roundId: zUuid,
  groupId: zUuid,
  participants: z.array(SimulateParticipant).max(10_000),
  overrides: z
    .array(z.object({ participantId: z.string().min(1), action: z.enum(["include", "exclude"]), reason: z.string() }))
    .default([]),
});

const EligibilityBody = z.object({
  versionId: zUuid.optional(),
  studentId: zUuid.optional(),
  dateOfBirth: zDate.optional(),
  grade: z.string().trim().max(40).optional(),
});

const Params = z.object({ tenantId: zUuid, competitionId: zUuid });
const VersionParams = Params.extend({ versionId: zUuid });

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse a config document; schema problems become VALIDATION_FAILED with paths. */
function parseConfig(input: unknown): CompetitionConfig {
  const result = CompetitionConfigSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      result.error.issues.map((i) => ({ path: ["config", ...i.path].join("."), message: i.message })),
    );
  }
  return result.data;
}

function canView(scope: TenantScope, competitionId: string): boolean {
  const perms = permissionsInCompetition(scope, competitionId);
  return COMPETITION_SCOPED_PERMISSIONS.some((p) => perms.has(p));
}

async function loadCompetition(tx: Tx, scope: TenantScope, competitionId: string, forUpdate = false): Promise<Competition> {
  let q = tx.selectFrom("competitions").selectAll().where("id", "=", competitionId).where("tenant_id", "=", scope.tenant.id);
  if (forUpdate) q = q.forUpdate();
  const c = await q.executeTakeFirst();
  if (!c) throw new AppError("NOT_FOUND");
  return c;
}

async function loadVersion(tx: Tx, competitionId: string, versionId: string, forUpdate = false): Promise<CompetitionVersion> {
  let q = tx.selectFrom("competition_versions").selectAll().where("id", "=", versionId).where("competition_id", "=", competitionId);
  if (forUpdate) q = q.forUpdate();
  const v = await q.executeTakeFirst();
  if (!v) throw new AppError("NOT_FOUND");
  return v;
}

/** Stored configs are re-parsed so documents saved under an older schema get the current defaults. */
export const asConfig = (json: unknown): CompetitionConfig => CompetitionConfigSchema.parse(json);

async function publishedConfig(tx: Tx, competition: Competition): Promise<CompetitionConfig | null> {
  if (!competition.current_version_id) return null;
  const v = await tx.selectFrom("competition_versions").select("config").where("id", "=", competition.current_version_id).executeTakeFirst();
  return v ? asConfig(v.config) : null;
}

/** Content references: each referenced Content Bank Version must exist in this tenant and cover the question count. */
async function contentIssues(tx: Tx, competition: Competition, config: CompetitionConfig): Promise<ConfigIssue[]> {
  const ids = [...new Set(config.rounds.flatMap((r) => r.groups.map((g) => g.content.contentBankVersionId)).filter((x): x is string => !!x))];
  const versions = new Map<string, VersionItemSummary[]>();
  if (ids.length) {
    // RLS limits both queries to this tenant, so another tenant's version id is "not found".
    const found = await tx.selectFrom("content_bank_versions").select("id").where("id", "in", ids).execute();
    for (const v of found) versions.set(v.id, []);
    const items = await tx
      .selectFrom("content_version_items")
      .select(["version_id", "content_type", "difficulty", "category", "tags", "locales"])
      .where("version_id", "in", ids)
      .execute();
    for (const i of items) {
      versions.get(i.version_id)?.push({
        contentType: i.content_type as VersionItemSummary["contentType"],
        difficulty: i.difficulty,
        category: i.category,
        tags: i.tags,
        locales: i.locales,
      });
    }
  }
  return validateContentReferences(config, versions, competition.content_locales);
}

async function allIssues(tx: Tx, competition: Competition, config: CompetitionConfig, published: CompetitionConfig | null): Promise<ConfigIssue[]> {
  return [...validateConfig(config, { published }), ...(await contentIssues(tx, competition, config))];
}

export async function competitionRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  /** Resolve scope and check the caller may see this competition (404 otherwise, like a foreign id). */
  async function scopeFor(request: FastifyRequest) {
    const params = parse(Params, request.params);
    const scope = await resolveTenantScope(db, request, params.tenantId);
    if (!canView(scope, params.competitionId)) throw new AppError("NOT_FOUND");
    return { scope, competitionId: params.competitionId };
  }

  app.get("/", async (request) => {
    const scope = await resolveTenantScope(db, request, parse(z.object({ tenantId: zUuid }), request.params).tenantId);
    const tenantWide = COMPETITION_SCOPED_PERMISSIONS.some((p) => scope.permissions.has(p));
    const scopedIds = [...scope.competitionRoles.keys()];
    if (!tenantWide && scopedIds.length === 0) throw new AppError("FORBIDDEN");
    const rows = await withContext(db, scope.db, (tx) => {
      let q = tx.selectFrom("competitions").selectAll().where("tenant_id", "=", scope.tenant.id).orderBy("created_at", "desc");
      if (!tenantWide) q = q.where("id", "in", scopedIds);
      return q.execute();
    });
    return { competitions: rows.map(presentCompetition) };
  });

  app.post("/", async (request, reply) => {
    const scope = await resolveTenantScope(db, request, parse(z.object({ tenantId: zUuid }), request.params).tenantId);
    // Creating competitions is a tenant-level power; competition-scoped admins cannot.
    requirePermission(scope, "competitions.manage");
    const body = parse(CreateBody, request.body);
    const currency = body.feeMode === "paid" ? (body.currency ?? scope.tenant.default_currency) : (body.currency ?? null);
    if (body.feeMode === "paid" && !currency) {
      throw new AppError("VALIDATION_FAILED", [{ path: "currency", message: "A paid competition needs a currency" }]);
    }
    const config = body.config === undefined ? standardTemplate() : parseConfig(body.config);

    const result = await withContext(db, scope.db, async (tx) => {
      const competition = await tx
        .insertInto("competitions")
        .values({
          tenant_id: scope.tenant.id,
          slug: body.slug,
          name: body.name,
          name_i18n: JSON.stringify(body.nameI18n ?? {}),
          description_i18n: JSON.stringify(body.descriptionI18n ?? {}),
          fee_mode: body.feeMode,
          currency,
          timezone: body.timezone ?? scope.tenant.timezone,
          interface_locales: body.interfaceLocales ?? [scope.tenant.default_locale],
          content_locales: body.contentLocales ?? [scope.tenant.default_locale],
          ...(body.visibility && { visibility: body.visibility }),
          current_version_id: null,
          created_by: scope.auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const version = await tx
        .insertInto("competition_versions")
        .values({
          tenant_id: scope.tenant.id,
          competition_id: competition.id,
          version_number: 1,
          config: JSON.stringify(config),
          change_note: null,
          created_by: scope.auth.userId,
          published_by: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "competition.created",
        targetType: "competition",
        targetId: competition.id,
        after: presentCompetition(competition),
      });
      return { competition, version, issues: await allIssues(tx, competition, config, null) };
    });
    return reply.status(201).send({
      competition: presentCompetition(result.competition),
      draft: presentVersion(result.version, result.issues),
    });
  });

  app.get("/:competitionId", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    return withContext(db, scope.db, async (tx) => {
      const competition = await loadCompetition(tx, scope, competitionId);
      const versions = await tx
        .selectFrom("competition_versions")
        .selectAll()
        .where("competition_id", "=", competitionId)
        .orderBy("version_number", "desc")
        .execute();
      return {
        competition: presentCompetition(competition),
        versions: versions.map(presentVersionSummary),
        permissions: [...permissionsInCompetition(scope, competitionId)].filter((p) => COMPETITION_SCOPED_PERMISSIONS.includes(p)).sort(),
      };
    });
  });

  app.patch("/:competitionId", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    requireCompetitionPermission(scope, competitionId, "competitions.manage");
    const body = parse(UpdateBody, request.body);
    const competition = await withContext(db, scope.db, async (tx) => {
      const before = await loadCompetition(tx, scope, competitionId, true);
      if (before.status === "cancelled" || before.status === "archived") throw new AppError("CONFLICT", { reason: "competition_closed" });
      const locked = (["feeMode", "currency", "timezone"] as const).filter((k) => body[k] !== undefined);
      if (before.first_published_at && locked.length > 0) {
        throw new AppError("CONFLICT", { reason: "locked_after_publish", fields: locked });
      }
      const feeMode = body.feeMode ?? before.fee_mode;
      const currency = body.currency !== undefined ? body.currency : before.currency;
      if (feeMode === "paid" && !currency) throw new AppError("VALIDATION_FAILED", [{ path: "currency", message: "A paid competition needs a currency" }]);
      const changes = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.nameI18n !== undefined && { name_i18n: JSON.stringify(body.nameI18n) }),
        ...(body.descriptionI18n !== undefined && { description_i18n: JSON.stringify(body.descriptionI18n) }),
        ...(body.visibility !== undefined && { visibility: body.visibility }),
        ...(body.interfaceLocales !== undefined && { interface_locales: body.interfaceLocales }),
        ...(body.contentLocales !== undefined && { content_locales: body.contentLocales }),
        ...(body.feeMode !== undefined && { fee_mode: body.feeMode }),
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.timezone !== undefined && { timezone: body.timezone }),
      };
      if (Object.keys(changes).length === 0) return before;
      const after = await tx.updateTable("competitions").set(changes).where("id", "=", competitionId).returningAll().executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "competition.updated",
        targetType: "competition",
        targetId: competitionId,
        before: pick(presentCompetition(before), Object.keys(body)),
        after: pick(presentCompetition(after), Object.keys(body)),
      });
      return after;
    });
    return { competition: presentCompetition(competition) };
  });

  app.post("/:competitionId/cancel", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    requireCompetitionPermission(scope, competitionId, "competitions.manage");
    const { reason } = parse(z.object({ reason: zReason }), request.body);
    const competition = await withContext(db, scope.db, async (tx) => {
      const before = await loadCompetition(tx, scope, competitionId, true);
      if (before.status === "cancelled") throw new AppError("CONFLICT", { reason: "already_cancelled" });
      const after = await tx
        .updateTable("competitions")
        .set({ status: "cancelled", cancelled_at: new Date() })
        .where("id", "=", competitionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "competition.cancelled",
        targetType: "competition",
        targetId: competitionId,
        reason,
        before: { status: before.status },
        after: { status: "cancelled" },
      });
      return after;
    });
    return { competition: presentCompetition(competition) };
  });

  // ---------------------------------------------------------------- versions

  /** Start a new draft from the published version (a planned change). */
  app.post("/:competitionId/versions", async (request, reply) => {
    const { scope, competitionId } = await scopeFor(request);
    requireCompetitionPermission(scope, competitionId, "competitions.manage");
    const version = await withContext(db, scope.db, async (tx) => {
      const competition = await loadCompetition(tx, scope, competitionId, true);
      if (competition.status === "cancelled" || competition.status === "archived") throw new AppError("CONFLICT", { reason: "competition_closed" });
      const draft = await tx.selectFrom("competition_versions").select("id").where("competition_id", "=", competitionId).where("status", "=", "draft").executeTakeFirst();
      if (draft) throw new AppError("CONFLICT", { reason: "draft_exists", versionId: draft.id });
      const base = await publishedConfig(tx, competition);
      if (!base) throw new AppError("CONFLICT", { reason: "nothing_published" });
      const { max } = await tx
        .selectFrom("competition_versions")
        .select((eb) => eb.fn.max("version_number").as("max"))
        .where("competition_id", "=", competitionId)
        .executeTakeFirstOrThrow();
      const v = await tx
        .insertInto("competition_versions")
        .values({
          tenant_id: scope.tenant.id,
          competition_id: competitionId,
          version_number: Number(max) + 1,
          config: JSON.stringify(base),
          change_note: null,
          created_by: scope.auth.userId,
          published_by: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "competition.draft_created",
        targetType: "competition_version",
        targetId: v.id,
        after: { competitionId, versionNumber: v.version_number },
      });
      return { v, issues: await allIssues(tx, competition, base, base) };
    });
    return reply.status(201).send({ version: presentVersion(version.v, version.issues) });
  });

  app.get("/:competitionId/versions/:versionId", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    const { versionId } = parse(VersionParams, request.params);
    return withContext(db, scope.db, async (tx) => {
      const competition = await loadCompetition(tx, scope, competitionId);
      const version = await loadVersion(tx, competitionId, versionId);
      const issues =
        version.status === "draft"
          ? await allIssues(tx, competition, asConfig(version.config), await publishedConfig(tx, competition))
          : [];
      return { version: presentVersion(version, issues) };
    });
  });

  /** Replace a draft's configuration. Sends back the revision it was based on. */
  app.put("/:competitionId/versions/:versionId/config", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    requireCompetitionPermission(scope, competitionId, "competitions.manage");
    const { versionId } = parse(VersionParams, request.params);
    const body = parse(SaveConfigBody, request.body);
    const config = parseConfig(body.config);
    const result = await withContext(db, scope.db, async (tx) => {
      const competition = await loadCompetition(tx, scope, competitionId);
      const before = await loadVersion(tx, competitionId, versionId, true);
      if (before.status !== "draft") throw new AppError("CONFLICT", { reason: "version_locked", status: before.status });
      if (before.revision !== body.revision) throw new AppError("CONFLICT", { reason: "stale_revision", currentRevision: before.revision });
      const version = await tx
        .updateTable("competition_versions")
        .set({ config: JSON.stringify(config), revision: before.revision + 1 })
        .where("id", "=", versionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "competition.config_saved",
        targetType: "competition_version",
        targetId: versionId,
        after: { revision: version.revision, changes: diffConfigs(asConfig(before.config), config) },
      });
      return { version, issues: await allIssues(tx, competition, config, await publishedConfig(tx, competition)) };
    });
    return { version: presentVersion(result.version, result.issues) };
  });

  /**
   * Publish a draft. Blocked while the validator reports errors. From the
   * second version on, a change note is required, and the version replaces the
   * previous one, which is kept as "superseded".
   */
  app.post("/:competitionId/versions/:versionId/publish", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    requireCompetitionPermission(scope, competitionId, "competitions.manage");
    const { versionId } = parse(VersionParams, request.params);
    const body = parse(PublishBody, request.body);
    const result = await withContext(db, scope.db, async (tx) => {
      const competition = await loadCompetition(tx, scope, competitionId, true);
      if (competition.status === "cancelled" || competition.status === "archived") throw new AppError("CONFLICT", { reason: "competition_closed" });
      const version = await loadVersion(tx, competitionId, versionId, true);
      if (version.status !== "draft") throw new AppError("CONFLICT", { reason: "version_locked", status: version.status });
      const previous = await publishedConfig(tx, competition);
      if (previous && !body.note) throw new AppError("REASON_REQUIRED", { field: "note" });
      const config = asConfig(version.config);
      const issues = await allIssues(tx, competition, config, previous);
      if (hasErrors(issues)) throw new AppError("CONFLICT", { reason: "config_has_errors", issues });

      const now = new Date();
      if (competition.current_version_id) {
        await tx.updateTable("competition_versions").set({ status: "superseded" }).where("id", "=", competition.current_version_id).execute();
      }
      const published = await tx
        .updateTable("competition_versions")
        .set({ status: "published", published_at: now, published_by: scope.auth.userId, change_note: body.note ?? null })
        .where("id", "=", versionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const updated = await tx
        .updateTable("competitions")
        .set({
          status: "published",
          current_version_id: versionId,
          first_published_at: competition.first_published_at ?? now,
        })
        .where("id", "=", competitionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, request, {
        tenantId: scope.tenant.id,
        actorUserId: scope.auth.userId,
        action: "competition.version_published",
        targetType: "competition_version",
        targetId: versionId,
        reason: body.note ?? null,
        before: { currentVersionId: competition.current_version_id, status: competition.status },
        after: { currentVersionId: versionId, versionNumber: published.version_number, changes: diffConfigs(previous, config) },
      });
      return { competition: updated, version: published, warnings: issues };
    });
    return { competition: presentCompetition(result.competition), version: presentVersion(result.version, result.warnings) };
  });

  // ---------------------------------------------------------------- engines

  /**
   * Dry-run the ranking and qualification rules of one round × group against
   * sample scores, so admins can check their rules before results exist.
   * Read-only; nothing is stored.
   */
  app.post("/:competitionId/versions/:versionId/simulate", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    const perms = permissionsInCompetition(scope, competitionId);
    if (!perms.has("competitions.manage") && !perms.has("ranking.read")) throw new AppError("FORBIDDEN");
    const { versionId } = parse(VersionParams, request.params);
    const body = parse(SimulateBody, request.body);
    const version = await withContext(db, scope.db, (tx) => loadVersion(tx, competitionId, versionId));
    const config = asConfig(version.config);
    const round = config.rounds.find((r) => r.id === body.roundId);
    const rg = round?.groups.find((g) => g.groupId === body.groupId && g.enabled);
    if (!round || !rg) throw new AppError("NOT_FOUND", { field: !round ? "roundId" : "groupId" });
    if (round.kind === "practice") throw new AppError("CONFLICT", { reason: "practice_round_has_no_official_ranking" });

    const tieBreakers = rg.ranking.tieBreakers;
    const ranking = rankParticipants(body.participants, tieBreakers);
    const scoped = Object.fromEntries(
      rg.ranking.scopes.filter((s) => s !== "group").map((s) => [s, rankByScope(body.participants, tieBreakers, s)]),
    );
    let qualification = null;
    if (rg.qualification) {
      try {
        qualification = evaluateQualification(ranking.ranked, rg.qualification, body.overrides, tieBreakers);
      } catch (err) {
        if (err instanceof QualificationError) throw new AppError("VALIDATION_FAILED", [{ path: "overrides", message: err.message }]);
        throw err;
      }
    }
    return { ranking, scopedRankings: scoped, qualification };
  });

  /** Which groups a student (or a given date of birth and grade) is eligible for. */
  app.post("/:competitionId/eligibility", async (request) => {
    const { scope, competitionId } = await scopeFor(request);
    const perms = permissionsInCompetition(scope, competitionId);
    if (!perms.has("competitions.manage") && !perms.has("registrations.manage")) throw new AppError("FORBIDDEN");
    const body = parse(EligibilityBody, request.body);
    return withContext(db, scope.db, async (tx) => {
      const competition = await loadCompetition(tx, scope, competitionId);
      const versionId = body.versionId ?? competition.current_version_id ?? (
        await tx.selectFrom("competition_versions").select("id").where("competition_id", "=", competitionId).where("status", "=", "draft").executeTakeFirst()
      )?.id;
      if (!versionId) throw new AppError("NOT_FOUND");
      const version = await loadVersion(tx, competitionId, versionId);
      let dateOfBirth = body.dateOfBirth;
      if (body.studentId) {
        // RLS limits this to students the caller can see in this tenant.
        const s = await tx
          .selectFrom("students")
          .innerJoin("tenant_students as ts", (j) => j.onRef("ts.student_id", "=", "students.id").on("ts.tenant_id", "=", scope.tenant.id))
          .select("students.date_of_birth")
          .where("students.id", "=", body.studentId)
          .executeTakeFirst();
        if (!s) throw new AppError("NOT_FOUND", { field: "studentId" });
        dateOfBirth ??= s.date_of_birth ?? undefined;
      }
      return {
        versionId,
        groups: eligibleGroups(asConfig(version.config), { dateOfBirth, grade: body.grade }),
      };
    });
  });
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
