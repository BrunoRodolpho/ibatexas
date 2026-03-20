// Tests for update_cart tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa response
// - Medusa error → {success: false, message: pt-BR}
// - Correct URL, method, and body

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

import { updateCart } from "../update-cart.js"
import { makeCtx, cartResponse, makeLineItem } from "./fixtures/medusa.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {
  cartId: "cart_01",
  itemId: "item_01",
  quantity: 5,
}

const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("updateCart", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())
  })

  it("calls medusaStoreFetch with correct path, POST method and quantity body", async () => {
    await updateCart(INPUT, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      `/store/carts/${INPUT.cartId}/line-items/${INPUT.itemId}`,
      {
        method: "POST",
        body: JSON.stringify({ quantity: INPUT.quantity }),
      },
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse({
      items: [makeLineItem({ quantity: 5, subtotal: 44500 })],
    })
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await updateCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns pt-BR error object when Medusa throws", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 400: Bad request"))

    const result = await updateCart(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Erro ao atualizar item no carrinho"),
    })
  })

  it("error message suggests retrying", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 500"))

    const result = await updateCart(INPUT, CTX) as { success: boolean; message: string }

    expect(result.message).toContain("Tente novamente")
  })

  it("sends quantity as integer in body", async () => {
    const input = { ...INPUT, quantity: 10 }

    await updateCart(input, CTX)

    const [, opts] = mockMedusaStoreFetch.mock.calls[0]
    const parsed = JSON.parse(opts.body)
    expect(parsed.quantity).toBe(10)
    expect(typeof parsed.quantity).toBe("number")
  })

  it("handles quantity of 1", async () => {
    const input = { ...INPUT, quantity: 1 }
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())

    await updateCart(input, CTX)

    const [, opts] = mockMedusaStoreFetch.mock.calls[0]
    expect(JSON.parse(opts.body).quantity).toBe(1)
  })
})
