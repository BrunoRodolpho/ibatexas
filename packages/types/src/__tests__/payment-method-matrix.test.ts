import { describe, it, expect } from "vitest"
import { canSwitchPaymentMethod } from "../payment-method-matrix.js"
import type { PaymentMethod } from "../payment-status.js"
import type { OrderType } from "../order-type.js"

describe("canSwitchPaymentMethod", () => {
  // Same method → always false
  it.each(["pix", "card", "cash"] as PaymentMethod[])(
    "returns false when switching %s → %s (same method)",
    (method) => {
      expect(canSwitchPaymentMethod(method, method, "delivery")).toBe(false)
      expect(canSwitchPaymentMethod(method, method, "pickup")).toBe(false)
      expect(canSwitchPaymentMethod(method, method, "dine_in")).toBe(false)
    },
  )

  // PIX ↔ card: always allowed
  it.each(["delivery", "pickup", "dine_in"] as OrderType[])(
    "allows PIX ↔ card for %s orders",
    (orderType) => {
      expect(canSwitchPaymentMethod("pix", "card", orderType)).toBe(true)
      expect(canSwitchPaymentMethod("card", "pix", orderType)).toBe(true)
    },
  )

  // cash → PIX/card: always allowed
  it.each(["delivery", "pickup", "dine_in"] as OrderType[])(
    "allows cash → PIX and cash → card for %s orders",
    (orderType) => {
      expect(canSwitchPaymentMethod("cash", "pix", orderType)).toBe(true)
      expect(canSwitchPaymentMethod("cash", "card", orderType)).toBe(true)
    },
  )

  // PIX/card → cash: blocked for delivery
  it("blocks PIX → cash for delivery orders", () => {
    expect(canSwitchPaymentMethod("pix", "cash", "delivery")).toBe(false)
  })

  it("blocks card → cash for delivery orders", () => {
    expect(canSwitchPaymentMethod("card", "cash", "delivery")).toBe(false)
  })

  // PIX/card → cash: allowed for pickup and dine_in
  it.each(["pickup", "dine_in"] as OrderType[])(
    "allows PIX → cash and card → cash for %s orders",
    (orderType) => {
      expect(canSwitchPaymentMethod("pix", "cash", orderType)).toBe(true)
      expect(canSwitchPaymentMethod("card", "cash", orderType)).toBe(true)
    },
  )
})
