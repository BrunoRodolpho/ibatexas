// Tests for apply_coupon tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa response with discount applied
// - Invalid coupon / Medusa error → {success: false, message: pt-BR}
// - Correct payload format (promo_codes array)

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

vi.mock("../assert-cart-ownership.js", () => ({
  assertCartOwnership: vi.fn().mockResolvedValue({ id: "cart_01", customer_id: "cus_01" }),
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { applyCoupon } from "../apply-coupon.js"
import { makeCtx, cartResponse } from "./fixtures/medusa.js"

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
    mockMedusaStoreFetch.mockResolvedValue(cartResponse({ discount_total: 1000 }))
  })

  it("calls medusaStoreFetch with correct promotions path and promo_codes array", async () => {
    await applyCoupon(INPUT, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      `/store/carts/${INPUT.cartId}/promotions`,
      {
        method: "POST",
        body: JSON.stringify({ promo_codes: [INPUT.code] }),
      },
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse({ discount_total: 1000 })
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await applyCoupon(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns pt-BR error when Medusa throws (invalid coupon)", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 400: Invalid promo code"))

    const result = await applyCoupon(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Cupom inv\u00e1lido"),
    })
  })

  it("error message includes instruction to verify code", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 400"))

    const result = await applyCoupon(INPUT, CTX) as { success: boolean; message: string }

    expect(result.message).toContain("Verifique o c\u00f3digo")
  })

  it("sends coupon code as single-element array", async () => {
    await applyCoupon(INPUT, CTX)

    const [, opts] = mockMedusaStoreFetch.mock.calls[0]
    const parsed = JSON.parse(opts.body)
    expect(Array.isArray(parsed.promo_codes)).toBe(true)
    expect(parsed.promo_codes).toHaveLength(1)
    expect(parsed.promo_codes[0]).toBe("CHURRASCO10")
  })

  it("handles different coupon codes", async () => {
    const input = { cartId: "cart_01", code: "BRISKET20" }
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())

    await applyCoupon(input, CTX)

    const [, opts] = mockMedusaStoreFetch.mock.calls[0]
    const parsed = JSON.parse(opts.body)
    expect(parsed.promo_codes[0]).toBe("BRISKET20")
  })

  it("returns error on 500 server error", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 500: Server Error"))

    const result = await applyCoupon(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("erro ao aplicar desconto"),
    })
  })
})
