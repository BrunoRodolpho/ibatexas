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
import { MedusaStoreAdjudicateRefusedError } from "../../medusa/store-adjudicated.js"
import { makeCtx, cartResponse } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockLineItemsAdd = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

// W9: add-to-cart now routes through medusaStoreAdjudicated. Mock the
// wrapper so the kernel + audit path is bypassed here — the wrapper
// itself is covered by packages/tools/src/medusa/__tests__/store-adjudicated.test.ts.
// The MedusaStoreAdjudicateRefusedError class is preserved (re-exported)
// so `instanceof` narrowing inside the tool keeps working in tests.
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
          add: mockLineItemsAdd,
        },
      },
    },
  }
})

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
    mockLineItemsAdd.mockResolvedValue(cartResponse())
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  it("calls medusaStoreAdjudicated.carts.lineItems.add with correct payload and meta", async () => {
    await addToCart(INPUT, CTX)

    expect(mockLineItemsAdd).toHaveBeenCalledWith(
      {
        cartId: INPUT.cartId,
        variantId: INPUT.variantId,
        quantity: INPUT.quantity,
      },
      expect.objectContaining({
        sourceSubject: "cart:add-to-cart",
        actorPrincipal: "llm",
        sessionId: CTX.sessionId,
      }),
    )
  })

  it("returns Medusa response on happy path", async () => {
    const medusaData = cartResponse()
    mockLineItemsAdd.mockResolvedValue(medusaData)

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

  it("stamps a unique nonce per add so JetStream dedup can't collapse two distinct adds", async () => {
    // Regression for the J1 cart.item_added undercount: the handler increments
    // cartAddCount with no consume-side dedup, so two genuinely-separate adds of
    // the same variant/qty must NOT carry an identical Nats-Msg-Id. The per-add
    // nonce is what keeps each publish byte-unique.
    await addToCart(INPUT, CTX)
    await addToCart(INPUT, CTX)

    const nonces = mockPublishNatsEvent.mock.calls
      .filter(([event]) => event === "cart.item_added")
      .map(([, payload]) => (payload as { nonce?: string }).nonce)

    expect(nonces).toHaveLength(2)
    expect(nonces[0]).toEqual(expect.any(String))
    expect(nonces[1]).toEqual(expect.any(String))
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it("returns error object when Medusa throws", async () => {
    mockLineItemsAdd.mockRejectedValue(new Error("Medusa 500: Internal"))

    const result = await addToCart(INPUT, CTX)

    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("Erro ao adicionar item ao carrinho"),
    })
  })

  it("does not publish NATS event when Medusa throws", async () => {
    mockLineItemsAdd.mockRejectedValue(new Error("Medusa 500"))

    await addToCart(INPUT, CTX)

    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })

  it("still returns Medusa data when NATS publish fails (non-fatal)", async () => {
    const medusaData = cartResponse()
    mockLineItemsAdd.mockResolvedValue(medusaData)
    mockPublishNatsEvent.mockRejectedValue(new Error("NATS down"))

    const result = await addToCart(INPUT, CTX)

    expect(result).toEqual(medusaData)
  })

  it("handles quantity of 1", async () => {
    const input = { ...INPUT, quantity: 1 }
    mockLineItemsAdd.mockResolvedValue(cartResponse())

    await addToCart(input, CTX)

    expect(mockLineItemsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        cartId: input.cartId,
        variantId: input.variantId,
        quantity: 1,
      }),
      expect.any(Object),
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

  // audit-2026-05-24 P2-2: when the kernel REFUSEs, the wrapper attaches
  // a kind-specific pt-BR userFacing copy. The tool must surface it
  // (not the generic "Erro ao adicionar..." fallback).
  it("surfaces wrapper userFacing copy on MedusaStoreAdjudicateRefusedError", async () => {
    const userFacing =
      "Não foi possível adicionar o item porque o produto não foi identificado."
    const refusedErr = new MedusaStoreAdjudicateRefusedError({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "medusa.store.payload.empty_variant_id",
        userFacing,
      },
      basis: [],
    })
    mockLineItemsAdd.mockRejectedValue(refusedErr)

    const result = await addToCart(INPUT, CTX)

    expect(result).toEqual({ success: false, message: userFacing })
  })
})
