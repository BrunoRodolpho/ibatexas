// Tests for remove_from_cart tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns Medusa response
// - Medusa error → {success: false, message: pt-BR}
// - Correct URL and method

import { describe, it, expect, beforeEach, vi } from "vitest"
import { removeFromCart } from "../remove-from-cart.js"
import { MedusaStoreAdjudicateRefusedError } from "../../medusa/store-adjudicated.js"
import { makeCtx, cartResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockLineItemsRemove = vi.hoisted(() => vi.fn())

// W9: remove-from-cart now routes through medusaStoreAdjudicated. Mock the
// wrapper so the kernel + audit path is bypassed here — the wrapper itself
// is covered by packages/tools/src/medusa/__tests__/store-adjudicated.test.ts.
// Preserve the real MedusaStoreAdjudicateRefusedError so `instanceof`
// narrowing inside remove-from-cart works correctly in tests.
vi.mock("../../medusa/store-adjudicated.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../medusa/store-adjudicated.js")>(
      "../../medusa/store-adjudicated.js",
    )
  return {
    ...actual,
    medusaStoreAdjudicated: {
      carts: {
        lineItems: {
          remove: mockLineItemsRemove,
        },
      },
    },
  }
})

vi.mock("../assert-cart-ownership.js", () => ({
  assertCartOwnership: vi.fn().mockResolvedValue({ id: "cart_01", customer_id: "cus_01" }),
}))

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
    mockLineItemsRemove.mockResolvedValue(cartResponse({ items: [] }))
  })

  it("calls medusaStoreAdjudicated.carts.lineItems.remove with correct payload and meta", async () => {
    await removeFromCart(INPUT, CTX)

    expect(mockLineItemsRemove).toHaveBeenCalledWith(
      {
        cartId: INPUT.cartId,
        itemId: INPUT.itemId,
      },
      expect.objectContaining({
        sourceSubject: "cart:remove-from-cart",
        actorPrincipal: "llm",
        sessionId: CTX.sessionId,
      }),
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse({ items: [] })
    mockLineItemsRemove.mockResolvedValue(medusaData)

    const result = await removeFromCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("returns pt-BR error object when Medusa throws", async () => {
    mockLineItemsRemove.mockRejectedValue(new Error("Medusa 404: Not found"))

    const result = await removeFromCart(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Erro ao remover item do carrinho"),
    })
  })

  it("error message suggests retrying", async () => {
    mockLineItemsRemove.mockRejectedValue(new Error("Medusa 500"))

    const result = await removeFromCart(INPUT, CTX) as { success: boolean; message: string }

    expect(result.message).toContain("Tente novamente")
  })

  it("handles different cart and item IDs correctly", async () => {
    const input = { cartId: "cart_99", itemId: "item_55" }
    mockLineItemsRemove.mockResolvedValue(cartResponse())

    await removeFromCart(input, CTX)

    expect(mockLineItemsRemove).toHaveBeenCalledWith(
      { cartId: "cart_99", itemId: "item_55" },
      expect.any(Object),
    )
  })

  // audit-2026-05-24 P2-2: kernel REFUSE userFacing copy is surfaced
  // instead of the generic "Erro ao remover..." fallback.
  it("surfaces wrapper userFacing copy on MedusaStoreAdjudicateRefusedError", async () => {
    const userFacing =
      "Não foi possível processar a operação no carrinho porque o item não foi identificado."
    const refusedErr = new MedusaStoreAdjudicateRefusedError({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "medusa.store.payload.empty_item_id",
        userFacing,
      },
      basis: [],
    })
    mockLineItemsRemove.mockRejectedValue(refusedErr)

    const result = await removeFromCart(INPUT, CTX)

    expect(result).toEqual({ success: false, message: userFacing })
  })
})
