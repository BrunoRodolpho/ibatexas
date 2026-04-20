// Order delivery type — delivery, pickup, or dine-in.

export const OrderType = {
  DELIVERY: "delivery",
  PICKUP: "pickup",
  DINE_IN: "dine_in",
} as const

export type OrderType = (typeof OrderType)[keyof typeof OrderType]

/** pt-BR display labels for each order type. */
export const ORDER_TYPE_LABELS_PT: Record<OrderType, string> = {
  [OrderType.DELIVERY]: "Entrega",
  [OrderType.PICKUP]: "Retirada",
  [OrderType.DINE_IN]: "No local",
}
