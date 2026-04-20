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
