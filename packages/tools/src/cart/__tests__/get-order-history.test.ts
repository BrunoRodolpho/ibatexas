// Tests for get_order_history tool
// Mock-based; no network required.
//
// Scenarios:
// - Happy path → returns orders list
// - Missing auth → throws with pt-BR message
// - Medusa error → {success: false, message: pt-BR}
// - Correct query params (customer_id, limit)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { getOrderHistory } from "../get-order-history.js"
import { makeCtx, makeGuestCtx, ordersListResponse, makeOrder } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdminFetch = vi.hoisted(() => vi.fn())
const mockGetById = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "cus_01", medusaId: null }))
const mockHGetAll = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock("../_shared.js", () => ({
  medusaAdminFetch: mockMedusaAdminFetch,
}))

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    getById: mockGetById,
  }),
}))

vi.mock("../../redis/client.js", () => ({
  getRedisClient: vi.fn().mockResolvedValue({
    hGetAll: mockHGetAll,
  }),
}))

vi.mock("../../redis/key.js", () => ({
  rk: vi.fn((key: string) => `ibx:${key}`),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = {} as Record<string, never>
const CTX = makeCtx()

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getOrderHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaAdminFetch.mockResolvedValue(ordersListResponse())
  })

  it("throws when customerId is missing (no auth)", async () => {
    const guestCtx = makeGuestCtx()

    await expect(getOrderHistory(INPUT, guestCtx)).rejects.toThrow("Autentica\u00e7\u00e3o necess\u00e1ria")
  })

  it("throws with pt-BR message for missing auth", async () => {
    const guestCtx = makeGuestCtx()

    await expect(getOrderHistory(INPUT, guestCtx)).rejects.toThrow("hist\u00f3rico de pedidos")
  })

  it("calls admin endpoint with metadata customerId and limit", async () => {
    await getOrderHistory(INPUT, CTX)

    expect(mockMedusaAdminFetch).toHaveBeenCalledWith(
      `/admin/orders?metadata[customerId]=${CTX.customerId}&limit=20`,
    )
  })

  it("returns orders list on happy path", async () => {
    const expected = ordersListResponse()
    mockMedusaAdminFetch.mockResolvedValue(expected)

    const result = await getOrderHistory(INPUT, CTX) as { orders: unknown[]; count: number }

    expect(result.orders).toEqual(expected.orders)
    expect(result.count).toBe(expected.count)
  })

  it("returns empty list when customer has no orders", async () => {
    const emptyList = { orders: [], count: 0, limit: 20, offset: 0 }
    mockMedusaAdminFetch.mockResolvedValue(emptyList)

    const result = await getOrderHistory(INPUT, CTX) as { orders: unknown[]; count: number }

    expect(result.orders).toHaveLength(0)
    expect(result.count).toBe(0)
  })

  it("returns pt-BR error when Medusa throws", async () => {
    mockMedusaAdminFetch.mockRejectedValue(new Error("Medusa 500"))

    const result = await getOrderHistory(INPUT, CTX) as { success: boolean; message: string }

    expect(result.success).toBe(false)
    expect(result.message).toContain("Erro ao buscar hist\u00f3rico de pedidos")
    expect(result.message).toContain("Tente novamente")
  })

  it("uses correct customerId from context in URL", async () => {
    const ctxOther = makeCtx({ customerId: "cus_42" })

    await getOrderHistory(INPUT, ctxOther)

    expect(mockMedusaAdminFetch).toHaveBeenCalledWith(
      "/admin/orders?metadata[customerId]=cus_42&limit=20",
    )
  })

  it("returns multiple orders with different statuses", async () => {
    const orders = [
      makeOrder({ id: "order_01", status: "pending" }),
      makeOrder({ id: "order_02", status: "completed" }),
      makeOrder({ id: "order_03", status: "cancelled" }),
    ]
    mockMedusaAdminFetch.mockResolvedValue(ordersListResponse(orders))

    const result = await getOrderHistory(INPUT, CTX) as { orders: Array<{ status: string }> }

    expect(result.orders).toHaveLength(3)
  })
})
