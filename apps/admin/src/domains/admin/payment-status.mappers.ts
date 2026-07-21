// OPS-011 — the closed PaymentStatus set the "Forçar status de pagamento"
// OWNER-only override can target. Mirrors the step-1 route's z.enum order
// (apps/api/src/routes/admin/payments.ts — PATCH .../payment/status), so the
// selector never offers a value the server would reject.

/** The 12 forceable payment statuses, in the route's z.enum order. */
export const FORCE_STATUS_VALUES = [
  'awaiting_payment',
  'payment_pending',
  'payment_expired',
  'payment_failed',
  'cash_pending',
  'paid',
  'switching_method',
  'partially_refunded',
  'refunded',
  'disputed',
  'canceled',
  'waived',
] as const

export type ForceStatusValue = (typeof FORCE_STATUS_VALUES)[number]

/** pt-BR labels (hard rule #4) for the selector option text. */
const FORCE_STATUS_LABELS_PT: Record<ForceStatusValue, string> = {
  awaiting_payment: 'Aguardando pagamento',
  payment_pending: 'Pagamento pendente',
  payment_expired: 'Pagamento expirado',
  payment_failed: 'Pagamento falhou',
  cash_pending: 'Dinheiro (pendente)',
  paid: 'Pago',
  switching_method: 'Trocando forma de pagamento',
  partially_refunded: 'Reembolso parcial',
  refunded: 'Reembolsado',
  disputed: 'Em disputa',
  canceled: 'Cancelado',
  waived: 'Isento',
}

/** pt-BR label for a status; RAW value fallback for an unknown value (never blank). */
export function forceStatusLabel(status: string): string {
  return FORCE_STATUS_LABELS_PT[status as ForceStatusValue] ?? status
}

export interface ForceStatusOption {
  readonly value: ForceStatusValue
  readonly label: string
}

/** Ready-to-render `<option>` rows, in route-enum order. */
export const FORCE_STATUS_OPTIONS: readonly ForceStatusOption[] = FORCE_STATUS_VALUES.map(
  (value) => ({ value, label: FORCE_STATUS_LABELS_PT[value] }),
)

/** Type guard — is a free string one of the forceable statuses? */
export function isForceStatusValue(value: string): value is ForceStatusValue {
  return (FORCE_STATUS_VALUES as readonly string[]).includes(value)
}
