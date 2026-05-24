// Tests for reorder tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → creates cart, adds items, returns cartId + NATS published
// - Missing auth → throws
// - Empty order items → message about unable to load
// - Some items fail to add → partial success with error note
// - Cart creation fails → error message
// - NATS publish failure → still returns result (non-fatal if .catch is used)
// - Items without variant_id are skipped
//
// ── W3 P1-L (audit remediation) ────────────────────────────────────────
//
// reorder.ts was previously on the ALLOWED_MEDUSA_DIRECT allow-list as
// "read-only fetches" but actually POSTed to /store/carts and
// /store/carts/:id/line-items. The writes now route through
// medusaAdjudicated() (Task 17 wrapper). Tests assert the adjudicated
// wrapper is called for writes; the legacy medusaStoreFetch is no
// longer used in this file.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { reorder } from "../reorder.js"
import { makeCtx, makeGuestCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdminFetch = vi.hoisted(() => vi.fn())
const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaAdminFetch: mockMedusaAdminFetch,
  medusaStoreFetch: mockMedusaStoreFetch,
}))

// W3 P1-L: reorder writes through medusaAdjudicated()
vi.mock("../../medusa/adjudicated.js", () => ({
  medusaAdjudicated: mockMedusaAdjudicated,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = { orderId: "order_01" }
const CTX = makeCtx()

const ORDER_WITH_ITEMS = {
  order: {
    customer_id: "cus_01",
    items: [
      { variant_id: "variant_costela_500g", quantity: 2, title: "Costela Bovina Defumada 500g" },
      { variant_id: "variant_linguica_1kg", quantity: 1, title: "Lingui\u00e7a Artesanal 1kg" },
    ],
  },
}

const CART_CREATED = { cart: { id: "cart_new_01" } }

// ── Tests ────────────────────────────────────────────────────────────────────

describe("reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaAdminFetch.mockResolvedValue(ORDER_WITH_ITEMS)
    // W3 P1-L: writes go through medusaAdjudicated().
    mockMedusaAdjudicated.mockResolvedValue(CART_CREATED)
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  it("throws when customerId is missing (no auth)", async () => {
    const guestCtx = makeGuestCtx()

    await expect(reorder(INPUT, guestCtx)).rejects.toThrow("Autentica\u00e7\u00e3o necess\u00e1ria")
  })

  it("fetches original order from admin API", async () => {
    await reorder(INPUT, CTX)

    expect(mockMedusaAdminFetch).toHaveBeenCalledWith("/admin/orders/order_01")
  })

  it("returns error message when order has no items", async () => {
    mockMedusaAdminFetch.mockResolvedValue({ order: { customer_id: "cus_01", items: [] } })

    const result = await reorder(INPUT, CTX)

    expect(result.message).toContain("N\u00e3o foi poss\u00edvel carregar os itens")
    expect(result.cartId).toBeUndefined()
  })

  it("returns error message when items is null/undefined", async () => {
    mockMedusaAdminFetch.mockResolvedValue({ order: { customer_id: "cus_01", items: null } })

    const result = await reorder(INPUT, CTX)

    expect(result.message).toContain("N\u00e3o foi poss\u00edvel carregar os itens")
  })

  it("creates a new cart with customer_id via medusaAdjudicated (W3 P1-L)", async () => {
    await reorder(INPUT, CTX)

    // First adjudicated call: cart create.
    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "store",
        method: "POST",
        path: "/store/carts",
        payload: { customer_id: CTX.customerId },
        sourceSubject: "tool:reorder",
      }),
    )
    // The legacy medusaStoreFetch path MUST NOT have been used for writes.
    expect(mockMedusaStoreFetch).not.toHaveBeenCalled()
  })

  it("returns error message when cart creation fails (no cart.id)", async () => {
    mockMedusaAdjudicated
      .mockResolvedValueOnce({ cart: undefined }) // cart creation returns no id

    const result = await reorder(INPUT, CTX)

    expect(result.message).toContain("Erro ao criar novo carrinho")
    expect(result.cartId).toBeUndefined()
  })

  it("adds each item from original order to new cart", async () => {
    // First call: create cart; subsequent calls: add items
    mockMedusaAdjudicated
      .mockResolvedValueOnce(CART_CREATED) // create cart
      .mockResolvedValueOnce({}) // add item 1
      .mockResolvedValueOnce({}) // add item 2

    await reorder(INPUT, CTX)

    // Cart creation + 2 item additions = 3 calls
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(3)

    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts/cart_new_01/line-items",
        payload: { variant_id: "variant_costela_500g", quantity: 2 },
      }),
    )

    expect(mockMedusaAdjudicated).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/store/carts/cart_new_01/line-items",
        payload: { variant_id: "variant_linguica_1kg", quantity: 1 },
      }),
    )
  })

  it("returns cartId and success message on happy path", async () => {
    mockMedusaAdjudicated
      .mockResolvedValueOnce(CART_CREATED)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const result = await reorder(INPUT, CTX)

    expect(result.cartId).toBe("cart_new_01")
    expect(result.message).toContain("Carrinho criado")
    expect(result.message).toContain("cart_new_01")
  })

  it("publishes NATS event with reorder info", async () => {
    mockMedusaAdjudicated
      .mockResolvedValueOnce(CART_CREATED)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await reorder(INPUT, CTX)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.item_added",
      expect.objectContaining({
        eventType: "cart.item_added",
        cartId: "cart_new_01",
        customerId: CTX.customerId,
        reorderFromOrderId: "order_01",
      }),
    )
  })

  it("includes unavailable items in error note when some fail", async () => {
    mockMedusaAdjudicated
      .mockResolvedValueOnce(CART_CREATED) // cart creation
      .mockResolvedValueOnce({}) // first item success
      .mockRejectedValueOnce(new Error("Variant unavailable")) // second item fails

    const result = await reorder(INPUT, CTX)

    expect(result.cartId).toBe("cart_new_01")
    expect(result.message).toContain("indispon\u00edvel")
    expect(result.message).toContain("Lingui\u00e7a Artesanal 1kg")
  })

  it("skips items without variant_id", async () => {
    mockMedusaAdminFetch.mockResolvedValue({
      order: {
        customer_id: "cus_01",
        items: [
          { variant_id: "variant_costela_500g", quantity: 2, title: "Costela" },
          { variant_id: undefined, quantity: 1, title: "Item Sem Variante" },
        ],
      },
    })
    mockMedusaAdjudicated
      .mockResolvedValueOnce(CART_CREATED) // create cart
      .mockResolvedValueOnce({}) // only one item added

    await reorder(INPUT, CTX)

    // Cart creation + 1 item (skipping the one without variant_id)
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(2)
  })

  it("handles all items failing to add", async () => {
    mockMedusaAdjudicated
      .mockResolvedValueOnce(CART_CREATED)
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))

    const result = await reorder(INPUT, CTX)

    expect(result.cartId).toBe("cart_new_01")
    expect(result.message).toContain("indispon\u00edvel")
    expect(result.message).toContain("Costela Bovina Defumada 500g")
    expect(result.message).toContain("Lingui\u00e7a Artesanal 1kg")
  })
})
