import type { Order, Payment, Refund, Registration } from "@cos/db";

export function presentRegistration(r: Registration) {
  return {
    id: r.id,
    competitionId: r.competition_id,
    competitionVersionId: r.competition_version_id,
    groupId: r.group_id,
    studentId: r.student_id,
    channel: r.channel,
    schoolId: r.school_id,
    contentLocale: r.content_locale,
    declaredGrade: r.declared_grade,
    status: r.status,
    holdExpiresAt: r.hold_expires_at,
    orderId: r.order_id,
    possibleDuplicateOf: r.possible_duplicate_of,
    duplicateResolution: r.duplicate_resolution,
    needsAttention: r.needs_attention,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    cancelledAt: r.cancelled_at,
  };
}

const n = (v: string | null) => (v === null ? null : Number(v));

export function presentOrder(o: Order) {
  return {
    id: o.id,
    orderNumber: o.order_number,
    competitionId: o.competition_id,
    kind: o.kind,
    schoolId: o.school_id,
    status: o.status,
    paymentMethod: o.payment_method,
    currency: o.currency,
    subtotalMinor: Number(o.subtotal_minor),
    discountMinor: Number(o.discount_minor),
    taxMinor: Number(o.tax_minor),
    totalMinor: Number(o.total_minor),
    refundedMinor: Number(o.refunded_minor),
    taxRateBps: o.tax_rate_bps,
    taxInclusive: o.tax_inclusive,
    platformFeeMinor: Number(o.platform_fee_minor),
    invoiceDueAt: o.invoice_due_at,
    externalReference: o.external_reference,
    expiresAt: o.expires_at,
    createdAt: o.created_at,
    paidAt: o.paid_at,
  };
}

export function presentPayment(p: Payment) {
  return { id: p.id, provider: p.provider, providerPaymentId: p.provider_payment_id, status: p.status, amountMinor: Number(p.amount_minor), currency: p.currency, gatewayFeeMinor: n(p.gateway_fee_minor), checkout: p.checkout, failureCode: p.failure_code, createdAt: p.created_at, succeededAt: p.succeeded_at };
}

export function presentRefund(r: Refund) {
  return { id: r.id, amountMinor: Number(r.amount_minor), currency: r.currency, reason: r.reason, status: r.status, providerRefundId: r.provider_refund_id, registrationIds: r.registration_ids, createdAt: r.created_at, completedAt: r.completed_at };
}
