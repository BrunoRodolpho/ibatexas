// Order fulfillment status enum — tracks kitchen-to-delivery lifecycle.
// Stored in Medusa's `fulfillment_status` field, validated by our domain layer.

export const OrderFulfillmentStatus = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  PREPARING: "preparing",
  READY: "ready",
  IN_DELIVERY: "in_delivery",
  DELIVERED: "delivered",
  CANCELED: "canceled",
} as const

export type OrderFulfillmentStatus = (typeof OrderFulfillmentStatus)[keyof typeof OrderFulfillmentStatus]

/** Forward-only transition matrix. Each key maps to the set of valid next statuses. */
const VALID_TRANSITIONS: Record<OrderFulfillmentStatus, readonly OrderFulfillmentStatus[]> = {
  [OrderFulfillmentStatus.PENDING]: [OrderFulfillmentStatus.CONFIRMED, OrderFulfillmentStatus.CANCELED],
  [OrderFulfillmentStatus.CONFIRMED]: [OrderFulfillmentStatus.PREPARING, OrderFulfillmentStatus.CANCELED],
  [OrderFulfillmentStatus.PREPARING]: [OrderFulfillmentStatus.READY, OrderFulfillmentStatus.CANCELED],
  [OrderFulfillmentStatus.READY]: [OrderFulfillmentStatus.IN_DELIVERY, OrderFulfillmentStatus.DELIVERED],
  [OrderFulfillmentStatus.IN_DELIVERY]: [OrderFulfillmentStatus.DELIVERED],
  [OrderFulfillmentStatus.DELIVERED]: [],
  [OrderFulfillmentStatus.CANCELED]: [],
}

/** Check if a status transition is allowed. */
export function canTransition(from: OrderFulfillmentStatus, to: OrderFulfillmentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Type-guard: is `s` one of the seven known fulfillment statuses? Reads the
 * same `VALID_TRANSITIONS` table (its keys ARE the status universe), so it can
 * never drift from the state machine. Used by the kernel transition-legality
 * guard (`@ibatexas/pack-orders`) to fail closed on an unknown current/target
 * status rather than trust an arbitrary string.
 */
export function isKnownOrderStatus(s: string): s is OrderFulfillmentStatus {
  return Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, s)
}

/**
 * BKL-150(b) — locale/alias aliases of the fulfillment-status tokens the ops
 * planner may emit for `order.status.transition`, mapped to the canonical en-US
 * enum value. Keyed by the NORMALIZED token (lowercased, diacritic-stripped,
 * whitespace-collapsed — see {@link normalizeOrderStatusToken}).
 *
 * Two families, both grounded (never invented): the en-GB spelling `cancelled`
 * (the sole enum value with an en-GB/en-US split — the live-observed defect),
 * and the pt-BR words the ops persona teaches / the 4B slips to despite the
 * "copie a string em inglês" instruction (`cancelar`/`cancelado`,
 * `confirmar`/`confirmado`, `preparar`/`preparando`, `pronto`, `entregue`, `em
 * entrega`). Anything NOT listed here is left verbatim so the strict kernel
 * guard still fails closed on a genuinely unknown token — this maps only known
 * alternate spellings of ALREADY-VALID values, it never widens the enum.
 */
const ORDER_STATUS_TOKEN_ALIASES: Readonly<Record<string, OrderFulfillmentStatus>> = {
  // en-GB spelling → en-US.
  cancelled: OrderFulfillmentStatus.CANCELED,
  // pt-BR (persona-taught) → en-US enum.
  cancelar: OrderFulfillmentStatus.CANCELED,
  cancelado: OrderFulfillmentStatus.CANCELED,
  confirmar: OrderFulfillmentStatus.CONFIRMED,
  confirmado: OrderFulfillmentStatus.CONFIRMED,
  preparar: OrderFulfillmentStatus.PREPARING,
  preparando: OrderFulfillmentStatus.PREPARING,
  pronto: OrderFulfillmentStatus.READY,
  entregue: OrderFulfillmentStatus.DELIVERED,
  "em entrega": OrderFulfillmentStatus.IN_DELIVERY,
  em_entrega: OrderFulfillmentStatus.IN_DELIVERY,
}

/**
 * BKL-150(b) — canonicalize an order-status token to the en-US enum value the
 * strict kernel legality guard (`@ibatexas/pack-orders`
 * `requireLegalStatusTransition`) reads. Normalizes casing / diacritics /
 * whitespace, passes an already-known enum value through, maps a KNOWN en-GB or
 * pt-BR alias ({@link ORDER_STATUS_TOKEN_ALIASES}) onto its canonical form, and
 * returns an UNKNOWN token VERBATIM so the guard still fails closed. Called ONLY
 * from the ops resolver's `order.status.transition` branch (before adjudication,
 * on the rebuilt envelope) — the guard itself performs NO normalization, keeping
 * one canonicalization seam and a strict guard.
 */
export function normalizeOrderStatusToken(raw: string): string {
  const key = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
  if (isKnownOrderStatus(key)) return key
  return ORDER_STATUS_TOKEN_ALIASES[key] ?? raw
}

/**
 * Is `status` terminal — i.e. has NO legal next state? Derived from the SAME
 * `VALID_TRANSITIONS` table (`delivered` / `canceled` map to `[]`), so terminal
 * membership is defined in exactly one place. The kernel legality guard emits a
 * distinct `TERMINAL_STATE` refusal for this case (vs. a merely illegal target).
 */
export function isTerminalOrderStatus(status: OrderFulfillmentStatus): boolean {
  return (VALID_TRANSITIONS[status]?.length ?? 0) === 0
}

/** Get the primary "advance" target for a given status (first non-cancel transition). */
export function getNextStatus(current: OrderFulfillmentStatus): OrderFulfillmentStatus | null {
  const targets = VALID_TRANSITIONS[current]
  if (!targets || targets.length === 0) return null
  return targets.find((s) => s !== OrderFulfillmentStatus.CANCELED) ?? null
}

/** pt-BR display labels for each status. */
export const ORDER_STATUS_LABELS_PT: Record<OrderFulfillmentStatus, string> = {
  [OrderFulfillmentStatus.PENDING]: "Pendente",
  [OrderFulfillmentStatus.CONFIRMED]: "Confirmado",
  [OrderFulfillmentStatus.PREPARING]: "Preparando",
  [OrderFulfillmentStatus.READY]: "Pronto",
  [OrderFulfillmentStatus.IN_DELIVERY]: "Em entrega",
  [OrderFulfillmentStatus.DELIVERED]: "Entregue",
  [OrderFulfillmentStatus.CANCELED]: "Cancelado",
}
