import { z } from "zod";
import { AppError, LOCALES, TENANT_ROLES } from "@cos/core";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export const zLocale = z.enum(LOCALES);
export const zTenantRole = z.enum(TENANT_ROLES);
export const zUuid = z.uuid();
export const zEmail = z.email().max(254).transform((s) => s.toLowerCase());
export const zPassword = z.string().min(10).max(200);
export const zUsername = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{2,39}$/i, "3-40 letters, digits, dot, dash or underscore")
  .transform((s) => s.toLowerCase());
export const zReason = z.string().trim().min(3).max(2000);
export const zDate = z.iso.date();
export const zName = z.string().trim().min(1).max(200);
export const zI18n = z.partialRecord(zLocale, z.string().trim().min(1).max(300));
