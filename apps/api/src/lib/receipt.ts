import { formatMoney } from "@cos/core";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABELS: Record<string, Record<string, string>> = {
  en: { receipt: "Receipt", invoice: "Invoice", order: "Order", date: "Date", item: "Item", amount: "Amount", subtotal: "Subtotal", discount: "Discount", tax: "Tax", taxIncluded: "Tax (included)", total: "Total", refunded: "Refunded", status: "Status", due: "Due", organizer: "Organizer", billedTo: "Billed to" },
  "zh-Hant": { receipt: "收據", invoice: "發票", order: "訂單", date: "日期", item: "項目", amount: "金額", subtotal: "小計", discount: "折扣", tax: "稅項", taxIncluded: "稅項（已含）", total: "總計", refunded: "已退款", status: "狀態", due: "到期日", organizer: "主辦機構", billedTo: "付款人" },
  "zh-Hans": { receipt: "收据", invoice: "发票", order: "订单", date: "日期", item: "项目", amount: "金额", subtotal: "小计", discount: "折扣", tax: "税项", taxIncluded: "税项（已含）", total: "总计", refunded: "已退款", status: "状态", due: "到期日", organizer: "主办机构", billedTo: "付款人" },
  th: { receipt: "ใบเสร็จรับเงิน", invoice: "ใบแจ้งหนี้", order: "คำสั่งซื้อ", date: "วันที่", item: "รายการ", amount: "จำนวนเงิน", subtotal: "ยอดรวมย่อย", discount: "ส่วนลด", tax: "ภาษี", taxIncluded: "ภาษี (รวมแล้ว)", total: "ยอดรวม", refunded: "คืนเงินแล้ว", status: "สถานะ", due: "ครบกำหนด", organizer: "ผู้จัด", billedTo: "ผู้ชำระ" },
};

export interface ReceiptData {
  locale: string;
  organizer: string;
  billedTo: string;
  order: {
    order_number: string; status: string; payment_method: string; currency: string; created_at: Date; paid_at: Date | null; invoice_due_at: Date | null;
    subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; refunded_minor: string; tax_inclusive: boolean | null;
  };
  lines: Array<{ description: string; total_minor: string }>;
}

/** Printable HTML receipt/invoice; browsers render every script and can save it as PDF. */
export function renderReceipt(d: ReceiptData): string {
  const L = LABELS[d.locale] ?? LABELS.en!;
  const m = (v: string | number) => esc(formatMoney(Number(v), d.order.currency, d.locale === "zh-Hant" ? "zh-HK" : d.locale));
  const isInvoice = d.order.payment_method === "invoice" && d.order.status === "pending";
  const title = isInvoice ? L.invoice : L.receipt;
  const date = (x: Date | null) => (x ? esc(x.toISOString().slice(0, 10)) : "");
  const row = (label: string, value: string) => `<tr><td>${esc(label)}</td><td class="r">${value}</td></tr>`;
  return `<!doctype html>
<html lang="${esc(d.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} ${esc(d.order.order_number)}</title>
<style>
body{font-family:system-ui,-apple-system,"Noto Sans","Noto Sans TC","Noto Sans SC","Noto Sans Thai",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#111;background:#fff}
h1{font-size:24px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px 4px;border-bottom:1px solid #ddd;text-align:left}
.r{text-align:right}.muted{color:#555}.total td{font-weight:700;border-top:2px solid #111}@media print{body{margin:0}}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="muted">${esc(L.order)} ${esc(d.order.order_number)} · ${esc(L.date)} ${date(d.order.paid_at ?? d.order.created_at)}${isInvoice ? ` · ${esc(L.due)} ${date(d.order.invoice_due_at)}` : ""}</p>
<p>${esc(L.organizer)}: ${esc(d.organizer)}<br>${esc(L.billedTo)}: ${esc(d.billedTo)}</p>
<table><thead><tr><th>${esc(L.item)}</th><th class="r">${esc(L.amount)}</th></tr></thead><tbody>
${d.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${m(l.total_minor)}</td></tr>`).join("\n")}
</tbody></table>
<table>
${row(L.subtotal!, m(d.order.subtotal_minor))}
${Number(d.order.discount_minor) ? row(L.discount!, `−${m(d.order.discount_minor)}`) : ""}
${Number(d.order.tax_minor) ? row(d.order.tax_inclusive ? L.taxIncluded! : L.tax!, m(d.order.tax_minor)) : ""}
<tr class="total"><td>${esc(L.total)}</td><td class="r">${m(d.order.total_minor)}</td></tr>
${Number(d.order.refunded_minor) ? row(L.refunded!, `−${m(d.order.refunded_minor)}`) : ""}
${row(L.status!, esc(d.order.status))}
</table>
</body></html>`;
}
