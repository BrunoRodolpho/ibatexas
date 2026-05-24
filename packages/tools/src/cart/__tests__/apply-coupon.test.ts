// Tests for apply_coupon tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa response with discount applied
// - Invalid coupon / Medusa error → {success: false, message: pt-BR}
// - Correct payload format (camelCase, single-element promo array)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { applyCoupon } from "../apply-coupon.js"
import { makeCtx, cartResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockPromotionsAdd = vi.hoisted(() => vi.fn())

// W9: apply-coupon now routes the Medusa promotions POST through
// medusaStoreAdjudicated. Mock the wrapper at the module boundary so the
// kernel + audit path is bypassed in this tool-level test — the wrapper
// itself is covered by packages/tools/src/medusa/__tests__/store-adjudicated.test.ts.
vi.mock("../../medusa/store-adjudicated.js", () => ({
  medusaStoreAdjudicated: {
    carts: {
      promotions: {
        add: mockPromotionsAdd,
      },
    },
  },
}))

vi.mock("../assert-cart-ownership.js", () => ({
  assertCartOwnership: vi.fn().mockResolvedValue({ id: "cart_01", customer_id: "cus_01" }),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {
  cartId: "cart_01",
  code: "CHURRASCO10",
}

const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("applyCoupon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPromotionsAdd.mockResolvedValue(cartResponse({ discount_total: 1000 }))
  })

  it("calls medusaStoreAdjudicated.carts.promotions.add with cartId + promoCodes payload and llm actor meta", async () => {
    await applyCoupon(INPUT, CTX)

    expect(mockPromotionsAdd).toHaveBeenCalledWith(
      { cartId: INPUT.cartId, promoCodes: [INPUT.code] },
      expect.objectContaining({
        sourceSubject: "cart:apply-coupon",
        actorPrincipal: "llm",
        customerId: CTX.customerId,
        sessionId: CTX.sessionId,
      }),
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse({ discount_total: 1000 })
    mockPromotionsAdd.mockResolvedValue(medusaData)

    const result = await applyCoupon(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns pt-BR error when Medusa throws (invalid coupon)", async () => {
    mockPromotionsAdd.mockRejectedValue(new Error("Medusa 400: Invalid promo code"))

    const result = await applyCoupon(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Cupom inválido"),
    })
  })

  it("error message includes instruction to verify code", async () => {
    mockPromotionsAdd.mockRejectedValue(new Error("Medusa 400"))

    const result = await applyCoupon(INPUT, CTX) as { success: boolean; message: string }

    expect(result.message).toContain("Verifique o código")
  })

  it("sends coupon code as single-element promoCodes array", async () => {
    await applyCoupon(INPUT, CTX)

    const [payload] = mockPromotionsAdd.mock.calls[0]
    expect(Array.isArray(payload.promoCodes)).toBe(true)
    expect(payload.promoCodes).toHaveLength(1)
    expect(payload.promoCodes[0]).toBe("CHURRASCO10")
  })

  it("handles different coupon codes", async () => {
    const input = { cartId: "cart_01", code: "BRISKET20" }
    mockPromotionsAdd.mockResolvedValue(cartResponse())

    await applyCoupon(input, CTX)

    const [payload] = mockPromotionsAdd.mock.calls[0]
    expect(payload.promoCodes[0]).toBe("BRISKET20")
  })

  it("returns error on 500 server error", async () => {
    mockPromotionsAdd.mockRejectedValue(new Error("Medusa 500: Server Error"))

    const result = await applyCoupon(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("erro ao aplicar desconto"),
    })
  })
})
