import { describe, expect, it } from "vitest";
import {
  HEAD_JUDGE_ONLY,
  TENANT_ROLES,
  hasPermission,
  negotiateLocale,
  normalizeLocale,
  permissionsFor,
} from "./index.ts";

describe("permissions", () => {
  it("only Head Judge can override official results or disqualify", () => {
    for (const p of HEAD_JUDGE_ONLY) {
      expect(hasPermission({ platformAdmin: true, tenantRoles: [] }, p)).toBe(false);
      for (const role of TENANT_ROLES) {
        expect(hasPermission({ platformAdmin: false, tenantRoles: [role] }, p)).toBe(role === "head_judge");
      }
    }
  });

  it("school admin cannot see tenant-wide students or audit logs", () => {
    const perms = permissionsFor({ platformAdmin: false, tenantRoles: ["school_admin"] });
    expect(perms.has("students.read")).toBe(false);
    expect(perms.has("audit.read")).toBe(false);
    expect(perms.has("school.roster.manage")).toBe(true);
  });

  it("roles combine", () => {
    const perms = permissionsFor({ platformAdmin: false, tenantRoles: ["judge", "school_admin"] });
    expect(perms.has("review.submit")).toBe(true);
    expect(perms.has("school.roster.read")).toBe(true);
    expect(perms.has("review.approve")).toBe(false);
  });
});

describe("locales", () => {
  it("normalizes regional Chinese tags", () => {
    expect(normalizeLocale("zh-HK")).toBe("zh-Hant");
    expect(normalizeLocale("zh-TW")).toBe("zh-Hant");
    expect(normalizeLocale("zh-Hant-HK")).toBe("zh-Hant");
    expect(normalizeLocale("zh-CN")).toBe("zh-Hans");
    expect(normalizeLocale("th-TH")).toBe("th");
    expect(normalizeLocale("fr-FR")).toBeNull();
  });

  it("negotiates Accept-Language by quality", () => {
    expect(negotiateLocale("fr;q=1, th;q=0.5, en;q=0.4")).toBe("th");
    expect(negotiateLocale("zh-HK,zh;q=0.9,en;q=0.8")).toBe("zh-Hant");
    expect(negotiateLocale(undefined)).toBeNull();
  });
});
