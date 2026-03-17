// Tests for get_cart tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa cart data
// - Medusa error → throws (no try/catch in source)
// - Correct URL path

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { getCart } from "../get-cart.js"
import { makeCtx, cartResponse, makeLineItem } from "./fixtures/medusa.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = { cartId: "cart_01" }
const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getCart", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())
  })

  it("calls medusaStoreFetch with correct path", async () => {
    await getCart(INPUT, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(`/store/carts/${INPUT.cartId}`)
  })

  it("returns Medusa cart response on happy path", async () => {
    const medusaData = cartResponse()
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await getCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns cart with items and totals", async () => {
    const medusaData = cartResponse({
      items: [
        makeLineItem({ id: "item_01", unit_price: 8900, quantity: 2, subtotal: 17800 }),
        makeLineItem({ id: "item_02", variant_id: "variant_linguica_1kg", unit_price: 4500, quantity: 1, subtotal: 4500 }),
      ],
      total: 22300,
    })
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await getCart(INPUT, CTX) as { cart: { total: number; items: unknown[] } }

    expect(result.cart.total).toBe(22300)
    expect(result.cart.items).toHaveLength(2)
  })

  it("returns empty cart when no items", async () => {
    const medusaData = cartResponse({ items: [], total: 0, subtotal: 0 })
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await getCart(INPUT, CTX) as { cart: { items: unknown[]; total: number } }

    expect(result.cart.items).toHaveLength(0)
    expect(result.cart.total).toBe(0)
  })

  it("throws when Medusa returns error (no catch in source)", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 404: Cart not found"))

    await expect(getCart(INPUT, CTX)).rejects.toThrow("Medusa 404")
  })

  it("handles different cart IDs", async () => {
    const input = { cartId: "cart_another_99" }
    mockMedusaStoreFetch.mockResolvedValue(cartResponse({ id: "cart_another_99" }))

    await getCart(input, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith("/store/carts/cart_another_99")
  })
})
