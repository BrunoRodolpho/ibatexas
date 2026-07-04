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
