// Tests for assertCartOwnership (P2-SEC-GUESTCART + existing owned-cart IDOR guard)
// Mock-based; no network or Redis required.
//
// Scenarios:
// - Owned cart, matching customer → returns cart
// - Owned cart, different customer → throws (existing behavior preserved)
// - Cart not found → throws
// - Guest cart, session already bound to a DIFFERENT cart → throws (IDOR)
// - Guest cart, session bound to THIS cart → returns cart
// - Guest cart, no binding yet → claims it for the session (NX), returns cart
// - Guest cart, no sessionId provided → permissive (legacy callers unchanged)
// - Redis unavailable → fails open (guest checkout not blocked by a Redis outage)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { assertCartOwnership } from "../assert-cart-ownership.js"

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

// Path is resolved relative to THIS test file; the source module imports
// "../redis/client.js" from src/cart/, which is src/redis/client.js — two
// levels up from src/cart/__tests__/.
vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

// rk() is pure — use the real implementation (prefixes with APP_ENV).
vi.mock("../../redis/key.js", async () => await vi.importActual("../../redis/key.js"))

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    ...overrides,
  }
}

describe("assertCartOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("throws when the cart is not found", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: undefined })
    await expect(assertCartOwnership("cart_01", "cus_01", "sess_01")).rejects.toThrow(
      "Carrinho não encontrado",
    )
  })

  it("returns the cart when an owned cart matches the customer", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_01", customer_id: "cus_01" } })
    const cart = await assertCartOwnership("cart_01", "cus_01", "sess_01")
    expect(cart.id).toBe("cart_01")
  })

  it("throws when an owned cart belongs to a different customer (IDOR)", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_01", customer_id: "cus_OTHER" } })
    await expect(assertCartOwnership("cart_01", "cus_ME", "sess_01")).rejects.toThrow(
      "pertence a outro cliente",
    )
  })

  // ── P2-SEC-GUESTCART ────────────────────────────────────────────────────────

  it("rejects a non-owning caller acting on a guest cart bound to another session", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_guest", customer_id: null } })
    // The caller's session is already bound to a DIFFERENT guest cart.
    const redis = createMockRedis({ get: vi.fn().mockResolvedValue("cart_someone_else") })
    mockGetRedisClient.mockResolvedValue(redis)

    await expect(assertCartOwnership("cart_guest", undefined, "sess_attacker")).rejects.toThrow(
      "não pertence à sua sessão",
    )
    // Must never claim/overwrite when a different binding exists.
    expect(redis.set).not.toHaveBeenCalled()
  })

  it("allows a guest cart when the caller's session is already bound to it", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_guest", customer_id: null } })
    const redis = createMockRedis({ get: vi.fn().mockResolvedValue("cart_guest") })
    mockGetRedisClient.mockResolvedValue(redis)

    const cart = await assertCartOwnership("cart_guest", undefined, "sess_owner")
    expect(cart.id).toBe("cart_guest")
  })

  it("claims an unbound guest cart for the caller's session (atomic NX)", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_guest", customer_id: null } })
    const redis = createMockRedis({ get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue("OK") })
    mockGetRedisClient.mockResolvedValue(redis)

    await assertCartOwnership("cart_guest", undefined, "sess_new")

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("cart:active:session:sess_new"),
      "cart_guest",
      expect.objectContaining({ NX: true }),
    )
  })

  it("rejects when losing the claim race to a different cart", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_guest", customer_id: null } })
    // No binding at first read, NX claim fails (someone won), re-read returns a different cart.
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("cart_winner")
    const redis = createMockRedis({ get, set: vi.fn().mockResolvedValue(null) })
    mockGetRedisClient.mockResolvedValue(redis)

    await expect(assertCartOwnership("cart_guest", undefined, "sess_loser")).rejects.toThrow(
      "não pertence à sua sessão",
    )
  })

  it("is permissive for guest carts when no sessionId is supplied (legacy callers)", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_guest", customer_id: null } })
    // No Redis access at all when sessionId is absent.
    const cart = await assertCartOwnership("cart_guest", undefined)
    expect(cart.id).toBe("cart_guest")
    expect(mockGetRedisClient).not.toHaveBeenCalled()
  })

  it("fails open (allows) when Redis is unavailable for a guest cart", async () => {
    mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_guest", customer_id: null } })
    mockGetRedisClient.mockRejectedValue(new Error("REDIS_URL env var required"))

    const cart = await assertCartOwnership("cart_guest", undefined, "sess_01")
    expect(cart.id).toBe("cart_guest")
  })
})
