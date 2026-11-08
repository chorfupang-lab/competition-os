import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompetitionConfig } from "@cos/core";
import { withContext } from "@cos/db";
import { call, createPlatformAdmin, createTenant, register, unique, type Session, type TenantFixture, useTestEnv } from "./helpers.ts";

const env = useTestEnv();
let A: TenantFixture;
let B: TenantFixture;
let frameworkId: string;
let toneSkill: string;
let bankId: string;
const c = (t: TenantFixture) => `/t/${t.tenantId}/content`;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const single = (key: string, extra: Record<string, unknown> = {}) => ({
  externalKey: key,
  contentType: "single_choice",
  baseLocale: "en",
  difficulty: "easy",
  body: { prompt: `What is 2 + 2? (${key})`, options: [{ id: "a", text: "3" }, { id: "b", text: "4" }], correctOptionId: "b" },
  ...extra,
});

async function createBank(t: TenantFixture, extra: Record<string, unknown> = {}) {
  const res = await call(env.app, t.admin, "POST", `${c(t)}/banks`, { key: unique("bank"), name: "Maths P4", baseLocale: "en", ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.bank.id as string;
}

async function upload(t: TenantFixture, bank: string, wb: ExcelJS.Workbook) {
  const res = await env.app.inject({
    method: "POST",
    url: `${c(t)}/banks/${bank}/imports`,
    headers: { ...t.admin.headers, "content-type": XLSX, "x-filename": "questions.xlsx" },
    payload: Buffer.from(await wb.xlsx.writeBuffer()),
  });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  const platform = await createPlatformAdmin(env);
  A = await createTenant(env, platform, "ContentA");
  B = await createTenant(env, platform, "ContentB");
  frameworkId = (await call(env.app, A.admin, "POST", `${c(A)}/skill-frameworks`, { key: "mandarin", name: "Mandarin" })).body.framework.id;
  const tones = await call(env.app, A.admin, "POST", `${c(A)}/skill-frameworks/${frameworkId}/skills`, { key: "tones", name: "Tones" });
  toneSkill = (await call(env.app, A.admin, "POST", `${c(A)}/skill-frameworks/${frameworkId}/skills`, { key: "tones.third", name: "Third tone", parentId: tones.body.skill.id })).body.skill.id;
  bankId = await createBank(A, { skillFrameworkId: frameworkId, requiredLocales: ["th"] });
});

describe("skill frameworks", () => {
  it("lists a hierarchical framework", async () => {
    const res = await call(env.app, A.admin, "GET", `${c(A)}/skill-frameworks/${frameworkId}`);
    const third = res.body.skills.find((s: { key: string }) => s.key === "tones.third");
    expect(third.parentId).toBe(res.body.skills.find((s: { key: string }) => s.key === "tones").id);
  });

  it("rejects a parent from another framework", async () => {
    const other = (await call(env.app, A.admin, "POST", `${c(A)}/skill-frameworks`, { key: unique("eng"), name: "English" })).body.framework.id;
    const res = await call(env.app, A.admin, "POST", `${c(A)}/skill-frameworks/${other}/skills`, { key: "x", name: "X", parentId: toneSkill });
    expect(res.status).toBe(404);
  });
});

describe("items", () => {
  it("validates the type-specific body and skill references", async () => {
    const bad = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("BAD-1", { body: { prompt: "x", options: [{ id: "a", text: "1" }], correctOptionId: "z" } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path)).toContain("body.options");

    const foreignSkill = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("BAD-2", { skillIds: [crypto.randomUUID()] }));
    expect(foreignSkill.status).toBe(400);
    expect(foreignSkill.body.error.details[0].path).toBe("skillIds.0");
  });

  it("creates, edits with revision checks, and refuses type changes", async () => {
    const created = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("ITEM-EDIT", { skillIds: [toneSkill], tags: ["P4"] }));
    expect(created.status).toBe(201);
    const item = created.body.item;
    expect(item).toMatchObject({ status: "draft", revision: 1, points: 1, tags: ["p4"], skillIds: [toneSkill] });

    const url = `${c(A)}/banks/${bankId}/items/${item.id}`;
    const edited = await call(env.app, A.admin, "PUT", url, { ...single("ITEM-EDIT", { difficulty: "hard" }), revision: 1 });
    expect(edited.body.item).toMatchObject({ revision: 2, difficulty: "hard" });
    expect((await call(env.app, A.admin, "PUT", url, { ...single("ITEM-EDIT"), revision: 1 })).status).toBe(409);
    const typeChange = await call(env.app, A.admin, "PUT", url, { externalKey: "ITEM-EDIT", contentType: "true_false", baseLocale: "en", difficulty: "easy", body: { prompt: "x", answer: true }, revision: 2 });
    expect(typeChange.body.error.details.reason).toBe("content_type_change");

    const dup = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("item-edit"));
    expect(dup.status).toBe(409);
  });

  it("grades a trial answer and previews translations", async () => {
    const item = (await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("ITEM-GRADE"))).body.item;
    const url = `${c(A)}/banks/${bankId}/items/${item.id}`;
    expect((await call(env.app, A.admin, "POST", `${url}/grade`, { response: { optionId: "b" } })).body.grade).toEqual({ outcome: "correct", fraction: 1 });
    await call(env.app, A.admin, "PUT", `${url}/translations/th`, { strings: { prompt: "2 + 2 เท่ากับเท่าไร" } });
    const preview = await call(env.app, A.admin, "GET", `${url}/preview?locale=th`);
    expect(preview.body.item.body.prompt).toBe("2 + 2 เท่ากับเท่าไร");
    expect(preview.body.item.body.options[1].text).toBe("4");
    expect(preview.body.translation).toMatchObject({ status: "draft", stale: false, missingPaths: ["options.a.text", "options.b.text"] });
  });

  it("retiring needs a reason and is final", async () => {
    const item = (await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("ITEM-RETIRE"))).body.item;
    const url = `${c(A)}/banks/${bankId}/items/${item.id}/status`;
    expect((await call(env.app, A.admin, "POST", url, { status: "retired" })).status).toBe(400);
    expect((await call(env.app, A.admin, "POST", url, { status: "retired", reason: "Ambiguous wording" })).status).toBe(200);
    expect((await call(env.app, A.admin, "POST", url, { status: "ready" })).status).toBe(409);
  });
});

describe("translations", () => {
  it("rejects unknown fields, requires completeness to approve, and goes stale when the text changes", async () => {
    const item = (await call(env.app, A.admin, "POST", `${c(A)}/banks/${bankId}/items`, single("ITEM-TR"))).body.item;
    const url = `${c(A)}/banks/${bankId}/items/${item.id}`;
    expect((await call(env.app, A.admin, "PUT", `${url}/translations/th`, { strings: { correctOptionId: "a" } })).status).toBe(400);
    expect((await call(env.app, A.admin, "PUT", `${url}/translations/en`, { strings: { prompt: "x" } })).status).toBe(400);
    expect((await call(env.app, A.admin, "PUT", `${url}/translations/th`, { strings: { prompt: "x" }, status: "approved" })).status).toBe(400);

    const full = { prompt: "2 + 2 เท่ากับเท่าไร", "options.a.text": "3", "options.b.text": "4" };
    const ok = await call(env.app, A.admin, "PUT", `${url}/translations/th`, { strings: full, status: "approved" });
    expect(ok.body.translation).toEqual({ locale: "th", status: "approved", stale: false, missingPaths: [] });

    await call(env.app, A.admin, "PUT", url, { ...single("ITEM-TR"), body: { ...single("x").body, prompt: "What is two plus two?" }, revision: 1 });
    const after = await call(env.app, A.admin, "GET", url);
    expect(after.body.item.translations[0]).toMatchObject({ locale: "th", status: "approved", stale: true });
  });
});

describe("publishing content bank versions", () => {
  it("publishes only ready items, requires current approved translations, and freezes the version", async () => {
    const bank = await createBank(A, { skillFrameworkId: frameworkId, requiredLocales: ["th"] });
    const mk = async (key: string, status: "ready" | "draft") =>
      (await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/items`, { ...single(key, { skillIds: [toneSkill] }), status })).body.item;
    const ready = await mk("V-1", "ready");
    await mk("V-DRAFT", "draft");

    expect((await call(env.app, A.admin, "POST", `${c(A)}/banks/${await createBank(A)}/versions`, {})).body.error.details.reason).toBe("no_ready_items");

    const missing = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/versions`, {});
    expect(missing.status).toBe(409);
    expect(missing.body.error.details).toMatchObject({ reason: "items_have_errors", total: 1, items: [{ externalKey: "V-1", issues: [{ path: "translations.th" }] }] });

    await call(env.app, A.admin, "PUT", `${c(A)}/banks/${bank}/items/${ready.id}/translations/th`, {
      strings: { prompt: "ข้อ 1", "options.a.text": "3", "options.b.text": "4" },
      status: "approved",
    });
    const res = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/versions`, { note: "First set" });
    expect(res.status).toBe(201);
    expect(res.body.version).toMatchObject({ versionNumber: 1, itemCount: 1, summary: { byType: { single_choice: 1 }, byLocale: { en: 1, th: 1 } } });

    const items = await call(env.app, A.admin, "GET", `${c(A)}/banks/${bank}/versions/${res.body.version.id}/items`);
    expect(items.body.items).toHaveLength(1);
    expect(items.body.items[0]).toMatchObject({
      item: { externalKey: "V-1", revision: 1 },
      translations: { th: { prompt: "ข้อ 1" } },
      skills: [{ id: toneSkill, key: "tones.third" }],
      locales: ["en", "th"],
    });

    // Editing the working copy doesn't touch the published version.
    await call(env.app, A.admin, "PUT", `${c(A)}/banks/${bank}/items/${ready.id}`, { ...single("V-1"), revision: 1 });
    const again = await call(env.app, A.admin, "GET", `${c(A)}/banks/${bank}/versions/${res.body.version.id}/items`);
    expect(again.body.items[0].item.revision).toBe(1);

    const ctx = { userId: A.admin.userId, tenantId: A.tenantId, platformAdmin: false, tenantWide: true, schoolIds: [] };
    await expect(
      withContext(env.db, ctx, (tx) => tx.updateTable("content_version_items").set({ difficulty: "hard" }).where("version_id", "=", res.body.version.id).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(env.owner.query("update content_version_items set difficulty = 'hard'")).rejects.toThrow(/cannot be changed/);
  });
});

describe("Excel import", () => {
  async function workbook(rows: { single?: Record<string, unknown>[]; tf?: Record<string, unknown>[]; fill?: Record<string, unknown>[]; tr?: Record<string, unknown>[] }) {
    // Start from the downloaded template, as a user would.
    const res = await env.app.inject({ method: "GET", url: `${c(A)}/banks/${bankId}/import-template`, headers: A.admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(XLSX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const fill = (name: string, data: Record<string, unknown>[] = []) => {
      const ws = wb.getWorksheet(name)!;
      const header = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
      for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).values = []; // clear the example row
      data.forEach((d, i) => {
        ws.getRow(i + 2).values = header.map((h) => (h in d ? (d[h] as ExcelJS.CellValue) : null));
      });
    };
    for (const ws of [...wb.worksheets]) if (!["README", "single_choice", "true_false", "fill_blank", "translations"].includes(ws.name)) wb.removeWorksheet(ws.id);
    fill("single_choice", rows.single);
    fill("true_false", rows.tf);
    fill("fill_blank", rows.fill);
    fill("translations", rows.tr);
    return wb;
  }

  it("the template has a sheet per question type and a translations sheet", async () => {
    const res = await env.app.inject({ method: "GET", url: `${c(A)}/banks/${bankId}/import-template`, headers: A.admin.headers });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["README", "single_choice", "pronunciation", "drag_drop", "custom", "translations"]));
    expect(wb.worksheets).toHaveLength(15);
  });

  it("validates with row-level errors, previews, commits, and detects unchanged rows", async () => {
    const bank = await createBank(A, { skillFrameworkId: frameworkId });
    const good = {
      single: [{ content_id: "X-1", difficulty: "easy", prompt: "2 + 2 = ?", option_a: "3", option_b: "4", answer: "B", skills: "tones.third", tags: "p4, maths" }],
      tf: [{ content_id: "X-2", difficulty: "medium", prompt: "The sun is a star.", answer: "TRUE" }],
      fill: [{ content_id: "X-3", difficulty: "hard", prompt: "我[[1]]學生。", blank_1: "是 | 系" }],
      tr: [
        { content_id: "X-1", locale: "zh-Hant", field: "prompt", text: "2 + 2 等於多少？", status: "draft" },
        { content_id: "X-2", locale: "th", field: "prompt", text: "ดวงอาทิตย์เป็นดาวฤกษ์", status: "approved" },
      ],
    };

    const bad = await upload(A, bank, await workbook({
      single: [...good.single, { content_id: "X-9", difficulty: "impossible", prompt: "?", option_a: "1", option_b: "2", answer: "C" }],
      tf: [{ content_id: "X-1", difficulty: "easy", prompt: "Dup", answer: "maybe" }],
      tr: [{ content_id: "NOPE", locale: "th", field: "prompt", text: "x" }],
    }));
    expect(bad.status).toBe(201);
    expect(bad.body.status).toBe("rejected");
    const errs = bad.body.errors.map((e: { sheet: string; row: number; field?: string }) => `${e.sheet}:${e.row}:${e.field}`);
    expect(errs).toEqual(expect.arrayContaining(["single_choice:3:difficulty", "single_choice:3:body", "true_false:2:answer", "translations:2:content_id"]));
    expect((await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/imports/${bad.body.id}/commit`)).status).toBe(409);

    const ok = await upload(A, bank, await workbook(good));
    expect(ok.body).toMatchObject({ status: "validated", summary: { create: 3, update: 0, unchanged: 0, translations: 2, errors: 0 } });
    expect(ok.body.preview.map((p: { externalKey: string }) => p.externalKey).sort()).toEqual(["X-1", "X-2", "X-3"]);
    expect((await call(env.app, A.admin, "GET", `${c(A)}/banks/${bank}/items`)).body.items).toHaveLength(0);

    const commit = await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/imports/${ok.body.id}/commit`);
    expect(commit.status).toBe(200);
    expect((await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/imports/${ok.body.id}/commit`)).status).toBe(409);

    const items = (await call(env.app, A.admin, "GET", `${c(A)}/banks/${bank}/items`)).body.items;
    const x1 = items.find((i: { externalKey: string }) => i.externalKey === "X-1");
    expect(x1).toMatchObject({ status: "ready", skillIds: [toneSkill], tags: ["p4", "maths"], body: { correctOptionId: "b" } });
    expect(x1.translations).toEqual([{ locale: "zh-Hant", status: "draft", stale: false, missingPaths: ["options.a.text", "options.b.text"] }]);
    const x3 = items.find((i: { externalKey: string }) => i.externalKey === "X-3");
    expect(x3.body.blanks).toEqual([{ id: "1", acceptedAnswers: ["是", "系"] }]);
    expect((await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/items/${x3.id}/grade`, { response: { blanks: { "1": "系" } } })).body.grade.outcome).toBe("correct");

    const same = await upload(A, bank, await workbook({ ...good, tr: [] }));
    expect(same.body.summary).toMatchObject({ create: 0, update: 0, unchanged: 3 });
    const changed = await upload(A, bank, await workbook({ ...good, tf: [{ ...good.tf[0], difficulty: "hard" }], tr: [] }));
    expect(changed.body.summary).toMatchObject({ create: 0, update: 1, unchanged: 2 });
    await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/imports/${changed.body.id}/commit`);
    const x2 = (await call(env.app, A.admin, "GET", `${c(A)}/banks/${bank}/items?q=X-2`)).body.items[0];
    expect(x2).toMatchObject({ difficulty: "hard", revision: 2 });
  });

  it("rejects files that are not workbooks", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: `${c(A)}/banks/${bankId}/imports`,
      headers: { ...A.admin.headers, "content-type": XLSX },
      payload: Buffer.from("not a zip"),
    });
    expect(res.json()).toMatchObject({ status: "rejected", errors: [{ message: "The file is not a valid .xlsx workbook" }] });
  });
});

describe("competitions reference content versions", () => {
  it("checks the pool size, formats and tenant of the referenced version", async () => {
    const bank = await createBank(A);
    for (let i = 0; i < 3; i++) await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/items`, { ...single(`POOL-${i}`), status: "ready" });
    const version = (await call(env.app, A.admin, "POST", `${c(A)}/banks/${bank}/versions`, {})).body.version.id;

    const bBank = await createBank(B);
    await call(env.app, B.admin, "POST", `${c(B)}/banks/${bBank}/items`, { ...single("B-1"), status: "ready" });
    const foreign = (await call(env.app, B.admin, "POST", `${c(B)}/banks/${bBank}/versions`, {})).body.version.id;

    const comp = await call(env.app, A.admin, "POST", `/t/${A.tenantId}/competitions`, { slug: unique("c"), name: "Pool", feeMode: "free" });
    const { id: competitionId } = comp.body.competition;
    const draft = comp.body.draft;
    const config: CompetitionConfig = structuredClone(draft.config);
    const qualifying = config.rounds[0]!;
    qualifying.groups[1]!.content.contentBankVersionId = version; // 20 questions wanted, 3 available
    qualifying.groups[2]!.content.contentBankVersionId = foreign;
    const save = (cfg: CompetitionConfig, revision: number) =>
      call(env.app, A.admin, "PUT", `/t/${A.tenantId}/competitions/${competitionId}/versions/${draft.id}/config`, { revision, config: cfg });

    let res = await save(config, 1);
    const codes = res.body.version.issues.map((i: { code: string; path: string }) => `${i.code}@${i.path}`);
    expect(codes).toContain("CONTENT_POOL_TOO_SMALL@rounds.0.groups.1.content");
    expect(codes).toContain("UNKNOWN_CONTENT_VERSION@rounds.0.groups.2.content.contentBankVersionId");

    qualifying.groups[1]!.questionCount = 3;
    qualifying.groups[2]!.content.contentBankVersionId = null;
    res = await save(config, 2);
    expect(res.body.version.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);

    qualifying.groups[1]!.questionFormats = ["text_input"];
    res = await save(config, 3);
    expect(res.body.version.issues.map((i: { code: string }) => i.code)).toContain("CONTENT_POOL_TOO_SMALL");
  });
});

describe("access", () => {
  it("other tenants, judges and school admins get the right access", async () => {
    expect((await call(env.app, B.admin, "GET", `${c(A)}/banks/${bankId}`)).status).toBe(404);
    expect((await call(env.app, B.admin, "GET", `${c(B)}/banks/${bankId}`)).status).toBe(404);

    const judge: Session = await register(env.app, "judge");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: judge.email, role: "judge" });
    expect((await call(env.app, judge, "GET", `${c(A)}/banks/${bankId}/items`)).status).toBe(200);
    expect((await call(env.app, judge, "POST", `${c(A)}/banks/${bankId}/items`, single("J-1"))).status).toBe(403);

    const school = (await call(env.app, A.admin, "POST", `/t/${A.tenantId}/schools`, { name: "S" })).body.school.id;
    const sa = await register(env.app, "sa");
    await call(env.app, A.admin, "POST", `/t/${A.tenantId}/members`, { email: sa.email, role: "school_admin", schoolId: school });
    expect((await call(env.app, sa, "GET", `${c(A)}/banks`)).status).toBe(403);
  });
});
