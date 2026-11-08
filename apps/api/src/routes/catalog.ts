import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { AppError, publicConfigView, type CompetitionConfig } from "@cos/core";
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
