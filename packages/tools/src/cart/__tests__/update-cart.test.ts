// Tests for update_cart tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa response
// - Medusa error → {success: false, message: pt-BR}
// - Correct URL, method, and body

import { describe, it, expect, beforeEach, vi } from "vitest"
import { updateCart } from "../update-cart.js"
import { makeCtx, cartResponse, makeLineItem } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockLineItemsUpdate = vi.hoisted(() => vi.fn())

// W9: update-cart now routes through medusaStoreAdjudicated. Mock the
// wrapper so the kernel + audit path is bypassed here — the wrapper
// itself is covered by packages/tools/src/medusa/__tests__/store-adjudicated.test.ts.
vi.mock("../../medusa/store-adjudicated.js", () => ({
  medusaStoreAdjudicated: {
    carts: {
      lineItems: {
        update: mockLineItemsUpdate,
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
  itemId: "item_01",
  quantity: 5,
}

const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("updateCart", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLineItemsUpdate.mockResolvedValue(cartResponse())
  })

  it("calls medusaStoreAdjudicated.carts.lineItems.update with correct payload and meta", async () => {
    await updateCart(INPUT, CTX)

    expect(mockLineItemsUpdate).toHaveBeenCalledWith(
      {
        cartId: INPUT.cartId,
        itemId: INPUT.itemId,
        quantity: INPUT.quantity,
      },
      expect.objectContaining({
        sourceSubject: "cart:update-cart",
        actorPrincipal: "llm",
        sessionId: CTX.sessionId,
      }),
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse({
      items: [makeLineItem({ quantity: 5, subtotal: 44500 })],
    })
    mockLineItemsUpdate.mockResolvedValue(medusaData)

    const result = await updateCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns pt-BR error object when Medusa throws", async () => {
    mockLineItemsUpdate.mockRejectedValue(new Error("Medusa 400: Bad request"))

    const result = await updateCart(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Erro ao atualizar item no carrinho"),
    })
  })

  it("error message suggests retrying", async () => {
    mockLineItemsUpdate.mockRejectedValue(new Error("Medusa 500"))

    const result = await updateCart(INPUT, CTX) as { success: boolean; message: string }

    expect(result.message).toContain("Tente novamente")
  })

  it("sends quantity as integer in payload", async () => {
    const input = { ...INPUT, quantity: 10 }

    await updateCart(input, CTX)

    const [payload] = mockLineItemsUpdate.mock.calls[0]
    expect(payload.quantity).toBe(10)
    expect(typeof payload.quantity).toBe("number")
  })

  it("handles quantity of 1", async () => {
    const input = { ...INPUT, quantity: 1 }
    mockLineItemsUpdate.mockResolvedValue(cartResponse())

    await updateCart(input, CTX)

    const [payload] = mockLineItemsUpdate.mock.calls[0]
    expect(payload.quantity).toBe(1)
  })
})
