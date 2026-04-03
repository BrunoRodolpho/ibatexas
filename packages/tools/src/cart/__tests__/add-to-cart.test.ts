// Tests for add_to_cart tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa data, NATS published
// - Medusa error → {success: false}, no NATS
// - NATS publish failure → non-fatal, returns Medusa data
// - Correct payload sent to Medusa

import { describe, it, expect, beforeEach, vi } from "vitest"
import { addToCart } from "../add-to-cart.js"
import { makeCtx, cartResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

vi.mock("../assert-cart-ownership.js", () => ({
  assertCartOwnership: vi.fn().mockResolvedValue({ id: "cart_01", customer_id: "cus_01" }),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {
  cartId: "cart_01",
  variantId: "variant_costela_500g",
  quantity: 2,
}

const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("addToCart", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  it("calls medusaStoreFetch with correct path, method and body", async () => {
    await addToCart(INPUT, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      `/store/carts/${INPUT.cartId}/line-items`,
      {
        method: "POST",
        body: JSON.stringify({ variant_id: INPUT.variantId, quantity: INPUT.quantity }),
      },
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse()
    mockMedusaStoreFetch.mockResolvedValue(medusaData)

    const result = await addToCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("publishes cart.item_added NATS event on success", async () => {
    await addToCart(INPUT, CTX)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.item_added",
      expect.objectContaining({
        eventType: "cart.item_added",
        cartId: INPUT.cartId,
        variantId: INPUT.variantId,
        quantity: INPUT.quantity,
        customerId: CTX.customerId,
        sessionId: CTX.sessionId,
      }),
    )
  })

  it("returns error object when Medusa throws", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 500: Internal"))

    const result = await addToCart(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Erro ao adicionar item ao carrinho"),
    })
  })

  it("does not publish NATS event when Medusa throws", async () => {
    mockMedusaStoreFetch.mockRejectedValue(new Error("Medusa 500"))

    await addToCart(INPUT, CTX)

    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })

  it("still returns Medusa data when NATS publish fails (non-fatal)", async () => {
    const medusaData = cartResponse()
    mockMedusaStoreFetch.mockResolvedValue(medusaData)
    mockPublishNatsEvent.mockRejectedValue(new Error("NATS down"))

    const result = await addToCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("handles quantity of 1", async () => {
    const input = { ...INPUT, quantity: 1 }
    mockMedusaStoreFetch.mockResolvedValue(cartResponse())

    await addToCart(input, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ variant_id: input.variantId, quantity: 1 }),
      }),
    )
  })

  it("passes correct customerId from context to NATS event", async () => {
    const ctxWithDifferentCustomer = makeCtx({ customerId: "cus_99" })

    await addToCart(INPUT, ctxWithDifferentCustomer)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.item_added",
      expect.objectContaining({ customerId: "cus_99" }),
    )
  })
})
