import type { Locale } from "./locales.ts";

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "TENANT_SUSPENDED",
  "REASON_REQUIRED",
  "RATE_LIMITED",
  "CSRF_REJECTED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TENANT_SUSPENDED: 403,
  REASON_REQUIRED: 400,
  RATE_LIMITED: 429,
  CSRF_REJECTED: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ErrorCode, details?: unknown, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

/** User-facing messages. Codes are the stable API contract; messages are for display. */
export const ERROR_MESSAGES: Record<Locale, Record<ErrorCode, string>> = {
  en: {
    VALIDATION_FAILED: "Some fields are missing or invalid.",
    UNAUTHENTICATED: "Please sign in.",
    INVALID_CREDENTIALS: "The sign-in details are incorrect.",
    FORBIDDEN: "You do not have permission to do this.",
    NOT_FOUND: "Not found.",
    CONFLICT: "This already exists.",
    TENANT_SUSPENDED: "This organization is suspended.",
    REASON_REQUIRED: "A reason is required for this action.",
    RATE_LIMITED: "Too many attempts. Please wait and try again.",
    CSRF_REJECTED: "The request was blocked for security reasons.",
    INTERNAL: "Something went wrong. Please try again.",
  },
  "zh-Hant": {
    VALIDATION_FAILED: "部分欄位缺漏或無效。",
    UNAUTHENTICATED: "請先登入。",
    INVALID_CREDENTIALS: "登入資料不正確。",
    FORBIDDEN: "你沒有權限執行此操作。",
    NOT_FOUND: "找不到相關資料。",
    CONFLICT: "資料已存在。",
    TENANT_SUSPENDED: "此機構已被暫停。",
    REASON_REQUIRED: "此操作需要填寫原因。",
    RATE_LIMITED: "嘗試次數過多，請稍後再試。",
    CSRF_REJECTED: "基於安全理由，請求已被拒絕。",
    INTERNAL: "發生錯誤，請重試。",
  },
  "zh-Hans": {
    VALIDATION_FAILED: "部分字段缺失或无效。",
    UNAUTHENTICATED: "请先登录。",
    INVALID_CREDENTIALS: "登录信息不正确。",
    FORBIDDEN: "你没有权限执行此操作。",
    NOT_FOUND: "找不到相关数据。",
    CONFLICT: "数据已存在。",
    TENANT_SUSPENDED: "此机构已被暂停。",
    REASON_REQUIRED: "此操作需要填写原因。",
    RATE_LIMITED: "尝试次数过多，请稍后再试。",
    CSRF_REJECTED: "出于安全原因，请求已被拒绝。",
    INTERNAL: "发生错误，请重试。",
  },
  th: {
    VALIDATION_FAILED: "ข้อมูลบางช่องขาดหายหรือไม่ถูกต้อง",
    UNAUTHENTICATED: "กรุณาเข้าสู่ระบบ",
    INVALID_CREDENTIALS: "ข้อมูลเข้าสู่ระบบไม่ถูกต้อง",
    FORBIDDEN: "คุณไม่มีสิทธิ์ดำเนินการนี้",
    NOT_FOUND: "ไม่พบข้อมูล",
    CONFLICT: "ข้อมูลนี้มีอยู่แล้ว",
    TENANT_SUSPENDED: "องค์กรนี้ถูกระงับการใช้งาน",
    REASON_REQUIRED: "การดำเนินการนี้ต้องระบุเหตุผล",
    RATE_LIMITED: "พยายามหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่",
    CSRF_REJECTED: "คำขอถูกปฏิเสธด้วยเหตุผลด้านความปลอดภัย",
    INTERNAL: "เกิดข้อผิดพลาด กรุณาลองใหม่",
  },
};
