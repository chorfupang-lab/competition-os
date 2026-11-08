/**
 * Excel bridge for content banks:
 *   Download Template → Fill → Upload → Validate → Preview / Error Report → Commit → Publish Version
 *
 * One sheet per question type (only the columns that type needs), plus a
 * long-format "translations" sheet (content_id, locale, field, text, status).
 * Parsing turns rows into content item inputs; skill and objective keys are
 * resolved later against the database.
 */
import ExcelJS from "exceljs";
import { QUESTION_TYPES, type QuestionType } from "@cos/core";

export const MAX_IMPORT_ROWS = 5000;
const LETTERS = ["a", "b", "c", "d", "e", "f"] as const;

const COMMON = [
  "content_id", "status", "base_locale", "difficulty", "points", "category", "tags", "skills", "objectives",
  "prompt", "prompt_image_url", "prompt_audio_url", "prompt_video_url", "explanation", "explanation_media_url", "source",
];
const CHOICE = [...LETTERS.map((l) => `option_${l}`), ...LETTERS.map((l) => `option_${l}_media_url`), "answer"];
const range = (prefix: string, n: number, suffix = "") => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}${suffix}`);

export const TYPE_COLUMNS: Record<QuestionType, string[]> = {
  single_choice: CHOICE,
  multiple_choice: [...CHOICE, "partial_credit"],
  true_false: ["answer"],
  matching: [...range("left", 8), ...range("right", 8)],
  ordering: [...range("item", 10), "partial_credit"],
  image_choice: CHOICE,
  audio_choice: CHOICE,
  listen_select: CHOICE,
  text_input: ["answers", "case_sensitive", "ignore_spaces"],
  fill_blank: [...range("blank", 6), "case_sensitive", "ignore_spaces", "partial_credit"],
  pronunciation: ["target_text", "speech_language", "romanization", "reference_audio_url", "aspects", "max_seconds"],
  drag_drop: [...range("target", 6), ...range("draggable", 10), ...range("draggable", 10, "_target"), "partial_credit"],
  custom: ["custom_type", "data_json"],
};

const TRANSLATION_COLUMNS = ["content_id", "locale", "field", "text", "status"];

const EXAMPLES: Partial<Record<QuestionType, Record<string, string | number>>> = {
  single_choice: { content_id: "MATH-P4-001", status: "ready", difficulty: "easy", points: 1, category: "arithmetic", tags: "p4, addition", prompt: "2 + 2 = ?", option_a: "3", option_b: "4", option_c: "5", answer: "B", explanation: "Two plus two is four." },
  multiple_choice: { content_id: "MATH-P4-002", difficulty: "medium", prompt: "Which are even?", option_a: "1", option_b: "2", option_c: "3", option_d: "4", answer: "B, D", partial_credit: "yes" },
  true_false: { content_id: "SCI-P4-001", difficulty: "easy", prompt: "Water boils at 100°C at sea level.", answer: "TRUE" },
  matching: { content_id: "MAND-P2-010", difficulty: "easy", prompt: "Match the words", left_1: "貓", right_1: "cat", left_2: "狗", right_2: "dog" },
  ordering: { content_id: "HIST-S1-003", difficulty: "hard", prompt: "Put in order, earliest first", item_1: "Tang", item_2: "Song", item_3: "Yuan" },
  text_input: { content_id: "GEO-P5-004", difficulty: "medium", prompt: "Capital of Thailand?", answers: "Bangkok | กรุงเทพ" },
  fill_blank: { content_id: "MAND-P3-020", difficulty: "medium", prompt: "我[[1]]學生。", blank_1: "是" },
  pronunciation: { content_id: "MAND-K3-001", difficulty: "easy", prompt: "Read aloud", target_text: "你好", speech_language: "cmn", romanization: "nǐ hǎo", aspects: "syllables, tones" },
  drag_drop: { content_id: "SCI-P3-007", difficulty: "medium", prompt: "Sort into groups", target_1: "Fruit", target_2: "Vegetable", draggable_1: "Apple", draggable_1_target: 1, draggable_2: "Carrot", draggable_2_target: 2, draggable_3: "Stone" },
};

export async function buildTemplate(bank: { baseLocale: string; requiredLocales: string[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const readme = wb.addWorksheet("README");
  readme.columns = [{ width: 110 }];
  [
    "Competition OS: content import template",
    "",
    "• One sheet per question type. Delete the sheets you don't need. Row 1 is the header; fill from row 2.",
    "• content_id is your own stable code (e.g. MATH-P4-001). Uploading the same content_id again updates that question.",
    "• status: ready (included in the next published version) or draft. difficulty: easy | medium | hard | expert.",
    `• base_locale: en | zh-Hant | zh-Hans | th (defaults to the bank's ${bank.baseLocale}).`,
    "• tags, skills, objectives, aspects: comma-separated. skills and objectives use the keys defined in the bank.",
    "• Choice answers use the option letter (B) or letters for multiple choice (B, D).",
    "• Text answers: separate accepted answers with |   e.g.  Bangkok | กรุงเทพ",
    "• fill_blank: mark blanks in the prompt as [[1]], [[2]] and give answers in blank_1, blank_2.",
    "• matching: left_N pairs with right_N. drag_drop: draggable_N goes to target number draggable_N_target; leave it empty for a distractor.",
    "• Media columns take https:// links.",
    `• translations sheet: one row per translated text. field is prompt, explanation, options.b.text, left.2.text, items.3.text, targets.1.text, draggables.2.text …${bank.requiredLocales.length ? ` Required locales: ${bank.requiredLocales.join(", ")}.` : ""}`,
    "• Upload the file to validate it. Nothing changes until you review the preview and commit.",
  ].forEach((line, i) => {
    const row = readme.addRow([line]);
    if (i === 0) row.font = { bold: true, size: 14 };
  });

  for (const type of QUESTION_TYPES) {
    const ws = wb.addWorksheet(type);
    const columns = [...COMMON, ...TYPE_COLUMNS[type]];
    ws.columns = columns.map((key) => ({ header: key, key, width: Math.max(12, key.length + 4) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    const ex = EXAMPLES[type];
    if (ex) ws.addRow(ex);
    const col = (name: string) => columns.indexOf(name) + 1;
    for (let r = 2; r <= 1000; r++) {
      ws.getCell(r, col("difficulty")).dataValidation = { type: "list", allowBlank: true, formulae: ['"easy,medium,hard,expert"'] };
      ws.getCell(r, col("status")).dataValidation = { type: "list", allowBlank: true, formulae: ['"ready,draft"'] };
    }
  }
  const tr = wb.addWorksheet("translations");
  tr.columns = TRANSLATION_COLUMNS.map((key) => ({ header: key, key, width: key === "text" ? 60 : 18 }));
  tr.getRow(1).font = { bold: true };
  tr.addRow({ content_id: "MATH-P4-001", locale: "th", field: "prompt", text: "2 + 2 เท่ากับเท่าไร", status: "draft" });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- parsing

export interface ImportError {
  sheet: string;
  row: number;
  field?: string;
  message: string;
}

export interface ParsedItemRow {
  sheet: string;
  row: number;
  status: "ready" | "draft";
  skillKeys: string[];
  objectiveKeys: string[];
  /** Content item input, without skillIds/objectiveIds (resolved from keys later). */
  input: Record<string, unknown>;
}

export interface ParsedTranslationRow {
  sheet: string;
  row: number;
  externalKey: string;
  locale: string;
  field: string;
  text: string;
  status: "draft" | "approved";
}

export interface ParsedWorkbook {
  items: ParsedItemRow[];
  translations: ParsedTranslationRow[];
  errors: ImportError[];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("").trim();
    if ("hyperlink" in v) return String(v.text ?? v.hyperlink).trim();
    if ("result" in v) return v.result === undefined || v.result === null ? "" : cellText(v.result as ExcelJS.CellValue);
    if ("error" in v) return "";
  }
  return String(v).trim();
}

const list = (s: string, sep = ",") => s.split(sep).map((x) => x.trim()).filter(Boolean);
const bool = (s: string): boolean | undefined => {
  const v = s.toLowerCase();
  if (!v) return undefined;
  if (["yes", "y", "true", "t", "1", "是", "ใช่"].includes(v)) return true;
  if (["no", "n", "false", "f", "0", "否", "ไม่"].includes(v)) return false;
  return undefined;
};

function mediaKind(url: string, forced?: "image" | "audio" | "video"): "image" | "audio" | "video" {
  if (forced) return forced;
  const path = url.toLowerCase().split("?")[0] ?? "";
  if (/\.(mp3|wav|m4a|ogg|aac|flac)$/.test(path)) return "audio";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  return "image";
}

export async function parseWorkbook(buffer: Buffer, defaults: { baseLocale: string }): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  const errors: ImportError[] = [];
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { items: [], translations: [], errors: [{ sheet: "", row: 0, message: "The file is not a valid .xlsx workbook" }] };
  }
  const items: ParsedItemRow[] = [];
  const translations: ParsedTranslationRow[] = [];
  let total = 0;

  wb.eachSheet((ws) => {
    const name = ws.name.trim();
    const isType = (QUESTION_TYPES as readonly string[]).includes(name);
    if (!isType && name !== "translations") return; // README and other sheets are ignored
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => cellText(v).toLowerCase());
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, string> = {};
      header.forEach((h, idx) => {
        if (h) values[h] = cellText(row.getCell(idx).value);
      });
      if (Object.values(values).every((v) => !v)) return;
      if (++total > MAX_IMPORT_ROWS) return;
      if (name === "translations") {
        const status = (values.status || "draft").toLowerCase();
        if (!values.content_id || !values.locale || !values.field) {
          errors.push({ sheet: name, row: rowNumber, message: "content_id, locale and field are required" });
          return;
        }
        if (status !== "draft" && status !== "approved") {
          errors.push({ sheet: name, row: rowNumber, field: "status", message: "status must be draft or approved" });
          return;
        }
        translations.push({ sheet: name, row: rowNumber, externalKey: values.content_id, locale: values.locale, field: values.field, text: values.text ?? "", status });
        return;
      }
      const result = rowToItem(name as QuestionType, values, defaults);
      if ("error" in result) errors.push({ sheet: name, row: rowNumber, ...result.error });
      else items.push({ sheet: name, row: rowNumber, ...result });
    });
  });
  if (total > MAX_IMPORT_ROWS) errors.unshift({ sheet: "", row: 0, message: `At most ${MAX_IMPORT_ROWS} rows per upload` });
  if (items.length === 0 && translations.length === 0 && errors.length === 0) {
    errors.push({ sheet: "", row: 0, message: "No question rows found. Use the sheets from the template." });
  }
  return { items, translations, errors };
}

function rowToItem(
  type: QuestionType,
  v: Record<string, string>,
  defaults: { baseLocale: string },
): Omit<ParsedItemRow, "sheet" | "row"> | { error: { field?: string; message: string } } {
  const status = (v.status || "ready").toLowerCase();
  if (status !== "ready" && status !== "draft") return { error: { field: "status", message: "status must be ready or draft" } };

  const promptMedia = [
    v.prompt_image_url && { kind: "image", url: v.prompt_image_url },
    v.prompt_audio_url && { kind: "audio", url: v.prompt_audio_url },
    v.prompt_video_url && { kind: "video", url: v.prompt_video_url },
  ].filter(Boolean);
  const flag = (k: string) => bool(v[k] ?? "");
  let body: Record<string, unknown>;

  switch (type) {
    case "single_choice":
    case "multiple_choice":
    case "image_choice":
    case "audio_choice":
    case "listen_select": {
      const forced = type === "image_choice" ? "image" : type === "audio_choice" ? "audio" : undefined;
      const options = LETTERS.flatMap((l) => {
        const text = v[`option_${l}`];
        const url = v[`option_${l}_media_url`];
        if (!text && !url) return [];
        return [{ id: l, ...(text && { text }), ...(url && { media: { kind: mediaKind(url, forced), url } }) }];
      });
      const answer = list((v.answer ?? "").toLowerCase());
      if (answer.length === 0) return { error: { field: "answer", message: "answer is required (option letter)" } };
      body = type === "multiple_choice"
        ? { options, correctOptionIds: answer, partialCredit: flag("partial_credit") ?? false }
        : { options, correctOptionId: answer[0] };
      if (type !== "multiple_choice" && answer.length > 1) return { error: { field: "answer", message: "only one answer letter is allowed" } };
      break;
    }
    case "true_false": {
      const answer = bool(v.answer ?? "");
      if (answer === undefined) return { error: { field: "answer", message: "answer must be TRUE or FALSE" } };
      body = { answer };
      break;
    }
    case "matching": {
      const left = range("left", 8).flatMap((k, i) => (v[k] ? [{ id: String(i + 1), text: v[k] }] : []));
      const right = range("right", 8).flatMap((k, i) => (v[k] ? [{ id: String(i + 1), text: v[k] }] : []));
      body = { left, right, pairs: left.filter((l) => right.some((r) => r.id === l.id)).map((l) => ({ leftId: l.id, rightId: l.id })) };
      break;
    }
    case "ordering": {
      const items = range("item", 10).flatMap((k, i) => (v[k] ? [{ id: String(i + 1), text: v[k] }] : []));
      body = { items, correctOrder: items.map((i) => i.id), partialCredit: flag("partial_credit") ?? false };
      break;
    }
    case "text_input":
      body = { acceptedAnswers: list(v.answers ?? "", "|"), caseSensitive: flag("case_sensitive") ?? false, ignoreSpaces: flag("ignore_spaces") ?? false };
      break;
    case "fill_blank":
      body = {
        blanks: range("blank", 6).flatMap((k, i) => (v[k] ? [{ id: String(i + 1), acceptedAnswers: list(v[k], "|") }] : [])),
        caseSensitive: flag("case_sensitive") ?? false,
        ignoreSpaces: flag("ignore_spaces") ?? false,
        partialCredit: flag("partial_credit") ?? true,
      };
      break;
    case "pronunciation":
      body = {
        targetText: v.target_text,
        speechLanguage: v.speech_language,
        ...(v.romanization && { romanization: v.romanization }),
        ...(v.reference_audio_url && { referenceAudio: { kind: "audio", url: v.reference_audio_url } }),
        ...(v.aspects && { aspects: list(v.aspects) }),
        ...(v.max_seconds && { maxRecordingSeconds: Number(v.max_seconds) }),
      };
      break;
    case "drag_drop": {
      const targets = range("target", 6).flatMap((k, i) => (v[k] ? [{ id: String(i + 1), text: v[k] }] : []));
      const draggables = range("draggable", 10).flatMap((k, i) => (v[k] ? [{ id: String(i + 1), text: v[k] }] : []));
      const placements = draggables.flatMap((d) => {
        const t = v[`draggable_${d.id}_target`];
        return t ? [{ draggableId: d.id, targetId: String(Number(t)) }] : [];
      });
      body = { targets, draggables, placements, partialCredit: flag("partial_credit") ?? true };
      break;
    }
    case "custom": {
      let data: unknown = {};
      if (v.data_json) {
        try {
          data = JSON.parse(v.data_json);
        } catch {
          return { error: { field: "data_json", message: "data_json is not valid JSON" } };
        }
      }
      body = { customType: v.custom_type, data };
      break;
    }
  }

  const explanationMedia = v.explanation_media_url ? [{ kind: mediaKind(v.explanation_media_url), url: v.explanation_media_url }] : [];
  return {
    status,
    skillKeys: list((v.skills ?? "").toLowerCase()),
    objectiveKeys: list((v.objectives ?? "").toLowerCase()),
    input: {
      externalKey: v.content_id,
      contentType: type,
      baseLocale: v.base_locale || defaults.baseLocale,
      difficulty: (v.difficulty ?? "").toLowerCase(),
      ...(v.points && { points: Number(v.points) }),
      category: v.category || null,
      tags: list(v.tags ?? ""),
      explanation: v.explanation || null,
      explanationMedia,
      sourceReference: v.source || null,
      body: { prompt: v.prompt, promptMedia, ...body },
    },
  };
}
