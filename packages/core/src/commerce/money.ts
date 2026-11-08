/**
 * Money is always an integer number of minor units (cents, satang) in the
 * competition's fixed currency (hard rule 29). No floating point.
 */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "IDR", "CLP", "ISK", "UGX", "XAF", "XOF"]);

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** 12345 HKD → "123.45" (for gateways that take decimal strings). */
export function minorToDecimal(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function decimalToMinor(value: string | number, currency: string): number {
  const exp = currencyExponent(currency);
  const [whole, frac = ""] = String(value).trim().split(".");
  const sign = whole!.startsWith("-") ? -1 : 1;
  const digits = (frac + "00").slice(0, exp);
  return sign * (Math.abs(Number(whole)) * 10 ** exp + (exp ? Number(digits) : 0));
}

export function formatMoney(minor: number, currency: string, locale = "en"): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp);
}

/** a × bps / 10000, rounded half up (bps = basis points, 1% = 100). */
export function applyBps(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps + 5000) / 10000);
}
