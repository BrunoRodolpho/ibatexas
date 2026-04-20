// Payment status enum — tracks billing lifecycle independently from order fulfillment.
// Each Payment row represents one payment attempt. Retry/regen creates a new row.
//
// Terminal statuses (per-attempt): refunded, canceled, waived, payment_failed, payment_expired.
// Non-terminal: awaiting_payment, payment_pending, cash_pending, paid, switching_method,
//               partially_refunded, disputed.

export const PaymentStatus = {
  AWAITING_PAYMENT: "awaiting_payment",
  PAYMENT_PENDING: "payment_pending",
  PAYMENT_EXPIRED: "payment_expired",
  PAYMENT_FAILED: "payment_failed",
  CASH_PENDING: "cash_pending",
  PAID: "paid",
  SWITCHING_METHOD: "switching_method",
  PARTIALLY_REFUNDED: "partially_refunded",
  REFUNDED: "refunded",
  DISPUTED: "disputed",
  CANCELED: "canceled",
  WAIVED: "waived",
} as const

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus]

/**
 * Terminal statuses for a Payment row — no further transitions possible.
 * Retry/regeneration creates a NEW Payment row; the old one stays terminal.
 * Used for: partial unique index, active-payment lookups, reconciliation guards.
 */
export const TERMINAL_PAYMENT_STATUSES = [
  PaymentStatus.REFUNDED,
  PaymentStatus.CANCELED,
  PaymentStatus.WAIVED,
  PaymentStatus.PAYMENT_FAILED,
  PaymentStatus.PAYMENT_EXPIRED,
] as const

export type TerminalPaymentStatus = (typeof TERMINAL_PAYMENT_STATUSES)[number]

/** Check if a payment status is terminal (no further transitions on this row). */
export function isTerminalPaymentStatus(status: PaymentStatus): status is TerminalPaymentStatus {
  return (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(status)
}

/** Forward-only transition matrix. Each key maps to the set of valid next statuses. */
const VALID_PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.AWAITING_PAYMENT]: [
    PaymentStatus.PAYMENT_PENDING,
    PaymentStatus.CASH_PENDING,
    PaymentStatus.CANCELED,
  ],
  [PaymentStatus.PAYMENT_PENDING]: [
    PaymentStatus.PAID,
    PaymentStatus.PAYMENT_EXPIRED,
    PaymentStatus.PAYMENT_FAILED,
    PaymentStatus.SWITCHING_METHOD,
    PaymentStatus.CANCELED,
  ],
  // Terminal per-attempt — retry creates a new Payment row
  [PaymentStatus.PAYMENT_EXPIRED]: [PaymentStatus.CANCELED],
  // Terminal per-attempt — retry creates a new Payment row
  [PaymentStatus.PAYMENT_FAILED]: [PaymentStatus.CANCELED],
  [PaymentStatus.CASH_PENDING]: [
    PaymentStatus.PAID,
    PaymentStatus.CANCELED,
  ],
  [PaymentStatus.SWITCHING_METHOD]: [
    PaymentStatus.PAYMENT_PENDING,
    PaymentStatus.CASH_PENDING,
    PaymentStatus.CANCELED,
  ],
  [PaymentStatus.PAID]: [
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.DISPUTED,
  ],
  [PaymentStatus.PARTIALLY_REFUNDED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.DISPUTED]: [
    PaymentStatus.PAID,     // dispute won
    PaymentStatus.REFUNDED, // dispute lost
  ],
  // Terminal states — no transitions
  [PaymentStatus.REFUNDED]: [],
  [PaymentStatus.CANCELED]: [],
  [PaymentStatus.WAIVED]: [],
}

/** Check if a payment status transition is allowed. */
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return VALID_PAYMENT_TRANSITIONS[from]?.includes(to) ?? false
}

/** pt-BR display labels for each payment status. */
export const PAYMENT_STATUS_LABELS_PT: Record<PaymentStatus, string> = {
  [PaymentStatus.AWAITING_PAYMENT]: "Aguardando pagamento",
  [PaymentStatus.PAYMENT_PENDING]: "Pagamento pendente",
  [PaymentStatus.PAYMENT_EXPIRED]: "Pagamento expirado",
  [PaymentStatus.PAYMENT_FAILED]: "Pagamento falhou",
  [PaymentStatus.CASH_PENDING]: "Dinheiro (pendente)",
  [PaymentStatus.PAID]: "Pago",
  [PaymentStatus.SWITCHING_METHOD]: "Trocando forma de pagamento",
  [PaymentStatus.PARTIALLY_REFUNDED]: "Reembolso parcial",
  [PaymentStatus.REFUNDED]: "Reembolsado",
  [PaymentStatus.DISPUTED]: "Em disputa",
  [PaymentStatus.CANCELED]: "Cancelado",
  [PaymentStatus.WAIVED]: "Isento",
}

/** Payment methods supported by the platform. */
export const PaymentMethod = {
  PIX: "pix",
  CARD: "card",
  CASH: "cash",
} as const

export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod]
