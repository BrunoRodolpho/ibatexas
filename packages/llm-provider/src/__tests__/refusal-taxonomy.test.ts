import { describe, expect, it } from "vitest"
import {
  GUARD_REFUSAL_MAP,
  refuseCartEmpty,
  refuseForbiddenPhrase,
  refuseInvalidPaymentMethod,
  refuseNotAuthenticated,
  refuseOrderAlreadyCancelled,
  refuseOrderAlreadyShipped,
} from "../refusal-taxonomy.js"

describe("refusal-taxonomy — stratification", () => {
  it("forbidden-phrase refusals are SECURITY", () => {
    expect(refuseForbiddenPhrase("post_order.idle", "pedido cancelado").kind).toBe(
      "SECURITY",
    )
    expect(refuseForbiddenPhrase("checkout.confirming", "processando").kind).toBe(
      "SECURITY",
    )
    expect(
      refuseForbiddenPhrase("ordering.awaiting_next", "pedido registrado").kind,
    ).toBe("SECURITY")
  })

  it("forbidden-phrase codes reflect the state family", () => {
    expect(refuseForbiddenPhrase("post_order.idle", "x").code).toBe(
      "post_order.forbidden_phrase",
    )
    expect(refuseForbiddenPhrase("checkout.confirming", "x").code).toBe(
      "checkout.forbidden_phrase",
    )
    expect(
      refuseForbiddenPhrase("ordering.awaiting_next", "x").code,
    ).toBe("ordering.forbidden_phrase")
  })

  it("auth refusals are AUTH", () => {
    expect(refuseNotAuthenticated().kind).toBe("AUTH")
  })

  it("cart-state refusals are STATE", () => {
    expect(refuseCartEmpty().kind).toBe("STATE")
  })

  it("order lifecycle refusals are STATE", () => {
    expect(refuseOrderAlreadyCancelled().kind).toBe("STATE")
    expect(refuseOrderAlreadyShipped().kind).toBe("STATE")
  })

  it("payment-method refusals are BUSINESS_RULE", () => {
    expect(refuseInvalidPaymentMethod("bitcoin").kind).toBe("BUSINESS_RULE")
  })

  it("GUARD_REFUSAL_MAP covers the load-bearing guards", () => {
    const required = [
      "isAuthenticated",
      "canCheckout",
      "hasCartItems",
      "canCancelOrder",
      "canAmendOrder",
      "hasOrderId",
      "allSlotsFilled",
    ]
    for (const name of required) {
      expect(GUARD_REFUSAL_MAP[name]).toBeTypeOf("function")
      expect(GUARD_REFUSAL_MAP[name]!().kind).toMatch(
        /^(AUTH|STATE|BUSINESS_RULE)$/,
      )
    }
  })

  it("user-facing text is pt-BR (no English fallbacks)", () => {
    const samples = [
      refuseNotAuthenticated(),
      refuseCartEmpty(),
      refuseOrderAlreadyCancelled(),
      refuseOrderAlreadyShipped(),
      refuseInvalidPaymentMethod("x"),
    ]
    for (const r of samples) {
      // Every message must include at least one Portuguese-specific token.
      expect(r.userFacing).toMatch(
        /pra|você|seu|sua|pedido|WhatsApp|carrinho|entrega|cadastrado|dispon[íi]vel/i,
      )
    }
  })
})
