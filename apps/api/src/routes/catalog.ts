import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError, CompetitionConfigSchema, displayName, publicConfigView, type CompetitionConfig, type LeaderboardPrivacy } from "@cos/core";
import { ANONYMOUS, withContext, type Tx } from "@cos/db";
import { parse, zUuid } from "../lib/validation.ts";

/**
 * Public catalog of published competitions, across tenants. No sign-in needed.
 * RLS exposes only published public/unlisted competitions of active tenants,
 * and only their current version. Unlisted ones are reachable by id but not listed.
 */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get("/", async (request) => {
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
      request.query,
    );
    const rows = await withContext(db, ANONYMOUS, (tx) =>
      tx
        .selectFrom("competitions as c")
        .innerJoin("competition_versions as v", "v.id", "c.current_version_id")
        .select(["c.id", "c.tenant_id", "c.slug", "c.name", "c.name_i18n", "c.description_i18n", "c.fee_mode", "c.currency", "c.timezone", "c.interface_locales", "c.content_locales", "v.config", "v.version_number"])
        .where("c.status", "=", "published")
        .where("c.visibility", "=", "public")
        .orderBy("c.first_published_at", "desc")
        .orderBy("c.id")
        .limit(q.limit)
        .offset(q.offset)
        .execute(),
    );
    const organizers = await withContext(db, ANONYMOUS, (tx) => organizerProfiles(tx, [...new Set(rows.map((r) => r.tenant_id))]));
    return { competitions: rows.map((r) => present(r, organizers.get(r.tenant_id) ?? null)) };
  });

  app.get("/:competitionId", async (request) => {
    const { competitionId } = parse(z.object({ competitionId: zUuid }), request.params);
    const row = await withContext(db, ANONYMOUS, (tx) =>
      tx
        .selectFrom("competitions as c")
        .innerJoin("competition_versions as v", "v.id", "c.current_version_id")
        .select(["c.id", "c.tenant_id", "c.slug", "c.name", "c.name_i18n", "c.description_i18n", "c.fee_mode", "c.currency", "c.timezone", "c.interface_locales", "c.content_locales", "v.config", "v.version_number"])
        .where("c.id", "=", competitionId)
        .where("c.status", "=", "published")
        .executeTakeFirst(),
    );
    if (!row) throw new AppError("NOT_FOUND");
    const organizers = await withContext(db, ANONYMOUS, (tx) => organizerProfiles(tx, [row.tenant_id]));
    return { competition: present(row, organizers.get(row.tenant_id) ?? null) };
  });

  /**
   * Public leaderboard for one round × group, from PUBLISHED results only
   * (or a provisional live board when the organizer enables it). Names follow
   * the competition's privacy mode; the platform Student ID is never shown.
   */
  app.get("/:competitionId/leaderboard", async (request) => {
    const { competitionId } = parse(z.object({ competitionId: zUuid }), request.params);
    const q = parse(z.object({ roundId: zUuid, groupId: zUuid }), request.query);
    return withContext(db, ANONYMOUS, async (tx) => {
      const comp = await tx
        .selectFrom("competitions as c")
        .innerJoin("competition_versions as v", "v.id", "c.current_version_id")
        .select(["c.id", "v.config"])
        .where("c.id", "=", competitionId)
        .where("c.status", "=", "published")
        .executeTakeFirst();
      if (!comp) throw new AppError("NOT_FOUND");
      const config = CompetitionConfigSchema.parse(comp.config);
      const { rows } = await sql<{ version_id: string; version_number: number; published_at: Date; publication: string; privacy: LeaderboardPrivacy; registration_id: string; student_id: string; status: string; total_score: string | null; rank: number | null; tied_with: number | null; qualified: boolean; given_name: string | null; family_name: string | null; preferred_name: string | null; nickname: string | null }>`
        select * from app.public_results(${competitionId}, ${q.roundId}, ${q.groupId})`.execute(tx);
      const entry = (r: { student_id: string; rank: number | null; tied_with: number | null; total_score: string | null; status: string; given_name: string | null; family_name: string | null; preferred_name: string | null; nickname: string | null }, privacy: LeaderboardPrivacy) => ({
        rank: r.rank,
        tied: (r.tied_with ?? 1) > 1,
        name: displayName(privacy, { competitionId, studentId: r.student_id, givenName: r.given_name, familyName: r.family_name, preferredName: r.preferred_name, nickname: r.nickname }),
        totalScore: r.total_score === null ? null : Number(r.total_score),
      });
      const ranked = <T extends { rank: number | null; status: string }>(list: T[]) => list.filter((r) => r.rank !== null && r.status === "ok").sort((a, b) => a.rank! - b.rank!);
      if (rows.length && resultsVisibleNow(rows[0]!.publication, config)) {
        return { official: true, versionNumber: rows[0]!.version_number, publishedAt: rows[0]!.published_at, entries: ranked(rows).map((r) => ({ ...entry(r, r.privacy), qualified: r.qualified })) };
      }
      const live = await sql<{ version_number: number; created_at: Date; privacy: LeaderboardPrivacy; student_id: string; status: string; total_score: string | null; rank: number | null; tied_with: number | null; given_name: string | null; family_name: string | null; preferred_name: string | null; nickname: string | null }>`
        select * from app.public_live_results(${competitionId}, ${q.roundId}, ${q.groupId})`.execute(tx);
      if (live.rows.length) {
        return { official: false, provisional: true, computedAt: live.rows[0]!.created_at, entries: ranked(live.rows).map((r) => entry(r, r.privacy)) };
      }
      throw new AppError("NOT_FOUND", { reason: "no_published_results" });
    });
  });
}

/** When approved results become public: on approval, or once the last round has closed. */
export function resultsVisibleNow(publication: string, config: CompetitionConfig, now = Date.now()): boolean {
  if (publication === "never") return false;
  if (publication === "after_competition_ends") return now >= Math.max(...config.rounds.map((r) => Date.parse(r.closesAt)));
  return true;
}

async function organizerProfiles(tx: Tx, tenantIds: string[]) {
  const out = new Map<string, { slug: string; name: string; nameI18n: unknown }>();
  for (const id of tenantIds) {
    const { rows } = await sql<{ slug: string; name: string; name_i18n: unknown }>`select slug, name, name_i18n from app.tenant_public_profile(${id})`.execute(tx);
    if (rows[0]) out.set(id, { slug: rows[0].slug, name: rows[0].name, nameI18n: rows[0].name_i18n });
  }
  return out;
}

function present(
  r: {
    id: string; slug: string; name: string; name_i18n: unknown; description_i18n: unknown; fee_mode: string; currency: string | null;
    timezone: string; interface_locales: string[]; content_locales: string[]; config: unknown; version_number: number;
  },
  organizer: { slug: string; name: string; nameI18n: unknown } | null,
) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    nameI18n: r.name_i18n,
    descriptionI18n: r.description_i18n,
    organizer,
    feeMode: r.fee_mode,
    currency: r.currency,
    timezone: r.timezone,
    interfaceLocales: r.interface_locales,
    contentLocales: r.content_locales,
    versionNumber: r.version_number,
    ...publicConfigView(r.config as CompetitionConfig),
  };
}
