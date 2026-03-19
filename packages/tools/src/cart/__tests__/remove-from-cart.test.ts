// Tests for remove_from_cart tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa response
// - Medusa error → {success: false, message: pt-BR}
// - Correct URL and method

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

// AUDIT-FIX: TOOL-C02 — mock assertCartOwnership (tested separately)
vi.mock("../assert-cart-ownership.js", () => ({
  assertCartOwnership: vi.fn().mockResolvedValue({ id: "cart_01", customer_id: "cus_01" }),
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { removeFromCart } from "../remove-from-cart.js"
import { makeCtx, cartResponse } from "./fixtures/medusa.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {
  cartId: "cart_01",
  itemId: "item_01",
}

const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("removeFromCart", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaStoreFetch.mockResolvedValue(cartResponse({ items: [] }))
  })

  it("calls medusaStoreFetch with correct path and DELETE method", async () => {
    await removeFromCart(INPUT, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      `/store/carts/${INPUT.cartId}/line-items/${INPUT.itemId}`,
      { method: "DELETE" },
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse({ items: [] })
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await removeFromCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns pt-BR error object when Medusa throws", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 404: Not found"))

    const result = await removeFromCart(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Erro ao remover item do carrinho"),
    })
  })

  it("error message suggests retrying", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 500"))

    const result = await removeFromCart(INPUT, CTX) as { success: boolean; message: string }

    expect(result.message).toContain("Tente novamente")
  })

  it("handles different cart and item IDs correctly", async () => {
    const input = { cartId: "cart_99", itemId: "item_55" }
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())

    await removeFromCart(input, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      "/store/carts/cart_99/line-items/item_55",
      { method: "DELETE" },
    )
  })
})
