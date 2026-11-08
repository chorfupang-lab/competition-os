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
  "NOT_ELIGIBLE",
  "REGISTRATION_CLOSED",
  "CONSENT_REQUIRED",
  "OFFER_CODE_INVALID",
  "PAYMENT_UNAVAILABLE",
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
  NOT_ELIGIBLE: 422,
  REGISTRATION_CLOSED: 409,
  CONSENT_REQUIRED: 400,
  OFFER_CODE_INVALID: 400,
  PAYMENT_UNAVAILABLE: 503,
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
    NOT_ELIGIBLE: "The student is not eligible for this group.",
    REGISTRATION_CLOSED: "Registration is not open.",
    CONSENT_REQUIRED: "Consent is required to register.",
    OFFER_CODE_INVALID: "This offer code cannot be used.",
    PAYMENT_UNAVAILABLE: "Online payment is not available right now. Please try again later.",
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
    NOT_ELIGIBLE: "學生不符合此組別的參賽資格。",
    REGISTRATION_CLOSED: "目前未開放報名。",
    CONSENT_REQUIRED: "報名須先同意相關條款。",
    OFFER_CODE_INVALID: "此優惠碼無法使用。",
    PAYMENT_UNAVAILABLE: "網上付款暫時未能使用，請稍後再試。",
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
    NOT_ELIGIBLE: "学生不符合此组别的参赛资格。",
    REGISTRATION_CLOSED: "目前未开放报名。",
    CONSENT_REQUIRED: "报名须先同意相关条款。",
    OFFER_CODE_INVALID: "此优惠码无法使用。",
    PAYMENT_UNAVAILABLE: "在线支付暂时无法使用，请稍后再试。",
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
    NOT_ELIGIBLE: "นักเรียนไม่มีคุณสมบัติสำหรับกลุ่มนี้",
    REGISTRATION_CLOSED: "ยังไม่เปิดรับสมัคร",
    CONSENT_REQUIRED: "ต้องให้ความยินยอมก่อนสมัคร",
    OFFER_CODE_INVALID: "ไม่สามารถใช้รหัสส่วนลดนี้ได้",
    PAYMENT_UNAVAILABLE: "ไม่สามารถชำระเงินออนไลน์ได้ในขณะนี้ กรุณาลองใหม่ภายหลัง",
    INTERNAL: "เกิดข้อผิดพลาด กรุณาลองใหม่",
  },
};
