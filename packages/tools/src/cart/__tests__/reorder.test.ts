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

import { describe, it, expect, beforeEach, vi } from "vitest"
import { reorder } from "../reorder.js"
import { makeCtx, makeGuestCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdminFetch = vi.hoisted(() => vi.fn())
const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaAdminFetch: mockMedusaAdminFetch,
  medusaStoreFetch: mockMedusaStoreFetch,
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
    mockMedusaStoreFetch.mockResolvedValue(CART_CREATED)
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

  it("creates a new cart with customer_id", async () => {
    await reorder(INPUT, CTX)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      "/store/carts",
      {
        method: "POST",
        body: JSON.stringify({ customer_id: CTX.customerId }),
      },
    )
  })

  it("returns error message when cart creation fails (no cart.id)", async () => {
    mockMedusaStoreFetch
      .mockResolvedValueOnce({ cart: undefined }) // cart creation returns no id

    const result = await reorder(INPUT, CTX)

    expect(result.message).toContain("Erro ao criar novo carrinho")
    expect(result.cartId).toBeUndefined()
  })

  it("adds each item from original order to new cart", async () => {
    // First call: create cart; subsequent calls: add items
    mockMedusaStoreFetch
      .mockResolvedValueOnce(CART_CREATED) // create cart
      .mockResolvedValueOnce({}) // add item 1
      .mockResolvedValueOnce({}) // add item 2

    await reorder(INPUT, CTX)

    // Cart creation + 2 item additions = 3 calls
    expect(mockMedusaStoreFetch).toHaveBeenCalledTimes(3)

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      "/store/carts/cart_new_01/line-items",
      {
        method: "POST",
        body: JSON.stringify({ variant_id: "variant_costela_500g", quantity: 2 }),
      },
    )

    expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
      "/store/carts/cart_new_01/line-items",
      {
        method: "POST",
        body: JSON.stringify({ variant_id: "variant_linguica_1kg", quantity: 1 }),
      },
    )
  })

  it("returns cartId and success message on happy path", async () => {
    mockMedusaStoreFetch
      .mockResolvedValueOnce(CART_CREATED)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const result = await reorder(INPUT, CTX)

    expect(result.cartId).toBe("cart_new_01")
    expect(result.message).toContain("Carrinho criado")
    expect(result.message).toContain("cart_new_01")
  })

  it("publishes NATS event with reorder info", async () => {
    mockMedusaStoreFetch
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
    mockMedusaStoreFetch
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
    mockMedusaStoreFetch
      .mockResolvedValueOnce(CART_CREATED) // create cart
      .mockResolvedValueOnce({}) // only one item added

    await reorder(INPUT, CTX)

    // Cart creation + 1 item (skipping the one without variant_id)
    expect(mockMedusaStoreFetch).toHaveBeenCalledTimes(2)
  })

  it("handles all items failing to add", async () => {
    mockMedusaStoreFetch
      .mockResolvedValueOnce(CART_CREATED)
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))

    const result = await reorder(INPUT, CTX)

    expect(result.cartId).toBe("cart_new_01")
    expect(result.message).toContain("indispon\u00edvel")
    expect(result.message).toContain("Costela Bovina Defumada 500g")
    expect(result.message).toContain("Lingui\u00e7a Artesanal 1kg")
  })

  // \u2500\u2500 P2-PERF-REORDER: line-items are added in parallel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  it("dispatches all line-item adds in parallel (does not await each sequentially)", async () => {
    // add#1 returns a promise that stays PENDING. Sequential code (await per
    // item) would block on it and never dispatch add#2. Parallel code
    // (Promise.allSettled over a synchronous .map) dispatches both up front, so
    // add#2 is called while add#1 is still pending.
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => { resolveFirst = r })
    const second = Promise.resolve({})

    const addPaths: string[] = []
    mockMedusaStoreFetch.mockImplementation((path: string) => {
      if (path === "/store/carts") return Promise.resolve(CART_CREATED)
      addPaths.push(path)
      return addPaths.length === 1 ? first : second
    })

    const promise = reorder(INPUT, CTX)

    // Drain all currently-pending microtasks/macrotasks (ownership check, order
    // fetch, cart create, and the parallel dispatch) without resolving add#1.
    await new Promise((r) => setTimeout(r, 0))

    // Both adds dispatched even though add#1 never resolved \u2192 parallel.
    expect(addPaths.filter((p) => p === "/store/carts/cart_new_01/line-items")).toHaveLength(2)

    resolveFirst({})
    const result = await promise
    expect(result.cartId).toBe("cart_new_01")
    expect(result.message).not.toContain("indispon\u00edvel")
  })

  it("uses Promise.allSettled so one failed add does not abort the others", async () => {
    // Reject the FIRST item; the second must still be attempted and succeed.
    mockMedusaStoreFetch
      .mockResolvedValueOnce(CART_CREATED)
      .mockRejectedValueOnce(new Error("first add fails"))
      .mockResolvedValueOnce({})

    const result = await reorder(INPUT, CTX)

    // Cart creation + both item adds attempted = 3 calls (no early abort).
    expect(mockMedusaStoreFetch).toHaveBeenCalledTimes(3)
    expect(result.cartId).toBe("cart_new_01")
    // Only the first item is reported unavailable.
    expect(result.message).toContain("Costela Bovina Defumada 500g")
    expect(result.message).not.toContain("Lingui\u00e7a Artesanal 1kg")
  })
})
