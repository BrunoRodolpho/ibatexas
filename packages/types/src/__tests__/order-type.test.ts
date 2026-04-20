import { describe, it, expect } from "vitest"
import { OrderType, ORDER_TYPE_LABELS_PT } from "../order-type.js"

describe("OrderType", () => {
  it("has exactly 3 values", () => {
    expect(Object.values(OrderType)).toHaveLength(3)
  })

  it.each([
    ["DELIVERY", "delivery"],
    ["PICKUP", "pickup"],
    ["DINE_IN", "dine_in"],
  ] as const)("OrderType.%s === '%s'", (key, value) => {
    expect(OrderType[key]).toBe(value)
  })

  it("has pt-BR labels for all values", () => {
    for (const value of Object.values(OrderType)) {
      expect(ORDER_TYPE_LABELS_PT[value]).toBeDefined()
      expect(typeof ORDER_TYPE_LABELS_PT[value]).toBe("string")
    }
  })
})
