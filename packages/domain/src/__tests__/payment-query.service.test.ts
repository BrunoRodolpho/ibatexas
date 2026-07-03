// Tests for PaymentQueryService
// Mock-based; no DB required.
//
// Scenarios:
// - getById: found — returns payment with history
// - getById: not found — returns null
// - getById: respects historyLimit
// - getActiveByOrderId: returns non-terminal payment
// - getActiveByOrderId: no active → null
// - listByOrderId: returns paginated list + count
// - listByOrderId: defaults limit=20, offset=0
// - getStatusHistory: returns chronological history
// - getByStripePaymentIntentId: found — returns payment
// - getByStripePaymentIntentId: not found — null

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockPaymentFindUnique = vi.hoisted(() => vi.fn())
const mockPaymentFindFirst = vi.hoisted(() => vi.fn())
const mockPaymentFindMany = vi.hoisted(() => vi.fn())
const mockPaymentCount = vi.hoisted(() => vi.fn())
const mockHistoryFindMany = vi.hoisted(() => vi.fn())

vi.mock("../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fns: unknown[]) => Promise.all(fns)),
    payment: {
      findUnique: mockPaymentFindUnique,
      findFirst: mockPaymentFindFirst,
      findMany: mockPaymentFindMany,
      count: mockPaymentCount,
    },
    paymentStatusHistory: {
      findMany: mockHistoryFindMany,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createPaymentQueryService } from "../services/payment-query.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "payment_pending",
    amountInCentavos: 8900,
    stripePaymentIntentId: "pi_test_123",
    pixExpiresAt: null,
    regenerationCount: 0,
    idempotencyKey: null,
    version: 2,
    lastStripeEventTs: null,
    createdAt: new Date("2026-04-12T10:00:00Z"),
    updatedAt: new Date("2026-04-12T10:05:00Z"),
    ...overrides,
  }
}

function makeHistory(overrides: Record<string, unknown> = {}) {
  return {
    id: "hist_01",
    paymentId: "pay_01",
    fromStatus: "awaiting_payment",
    toStatus: "payment_pending",
    actor: "system",
    actorId: null,
    reason: null,
    version: 2,
    createdAt: new Date("2026-04-12T10:05:00Z"),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PaymentQueryService", () => {
  let svc: ReturnType<typeof createPaymentQueryService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createPaymentQueryService()
  })

  // ── getById ───────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns payment with status history", async () => {
      const payment = { ...makePayment(), statusHistory: [makeHistory()] }
      mockPaymentFindUnique.mockResolvedValue(payment)

      const result = await svc.getById("pay_01")

      expect(result).toEqual(payment)
      expect(mockPaymentFindUnique).toHaveBeenCalledWith({
        where: { id: "pay_01" },
        include: {
          statusHistory: {
            orderBy: { createdAt: "asc" },
            take: 200,
          },
        },
      })
    })

    it("returns null when payment not found", async () => {
      mockPaymentFindUnique.mockResolvedValue(null)

      const result = await svc.getById("pay_missing")
      expect(result).toBeNull()
    })

    it("respects historyLimit option", async () => {
      mockPaymentFindUnique.mockResolvedValue({ ...makePayment(), statusHistory: [] })

      await svc.getById("pay_01", { historyLimit: 5 })

      const call = mockPaymentFindUnique.mock.calls[0][0]
      expect(call.include.statusHistory.take).toBe(5)
    })
  })

  // ── listByCustomer (BKL-071 — owner-scoped billing history) ───────────

  describe("listByCustomer", () => {
    it("scopes by the OrderProjection owner join, desc, default take=20", async () => {
      const rows = [makePayment(), makePayment({ id: "pay_02", status: "refunded" })]
      mockPaymentFindMany.mockResolvedValue(rows)

      const result = await svc.listByCustomer("cus_01")

      expect(result).toEqual(rows)
      const call = mockPaymentFindMany.mock.calls[0][0]
      // Owner scope is the parent order's customerId (Payment carries none).
      expect(call.where).toEqual({ order: { customerId: "cus_01" } })
      expect(call.orderBy).toEqual({ createdAt: "desc" })
      expect(call.take).toBe(20)
    })

    it("includes TERMINAL statuses — NO status filter (history, not active-only)", async () => {
      mockPaymentFindMany.mockResolvedValue([])

      await svc.listByCustomer("cus_01")

      // The active-payment path excludes terminals; history must NOT — assert
      // there is no `status` predicate at all so refunded/failed/settled rows show.
      const call = mockPaymentFindMany.mock.calls[0][0]
      expect(call.where.status).toBeUndefined()
    })

    it("respects a custom limit", async () => {
      mockPaymentFindMany.mockResolvedValue([])

      await svc.listByCustomer("cus_01", { limit: 5 })

      expect(mockPaymentFindMany.mock.calls[0][0].take).toBe(5)
    })
  })

  // ── countByCustomer (BKL-071 — honest total behind a page) ────────────

  describe("countByCustomer", () => {
    it("counts through the SAME owner-scoped order join (identical IDOR discipline)", async () => {
      mockPaymentCount.mockResolvedValue(137)

      const total = await svc.countByCustomer("cus_01")

      expect(total).toBe(137)
      // The join MUST match listByCustomer's exactly — a Payment carries no
      // customerId, so ownership is only the parent order's customerId.
      expect(mockPaymentCount).toHaveBeenCalledWith({
        where: { order: { customerId: "cus_01" } },
      })
    })
  })

  // ── getActiveByOrderId ────────────────────────────────────────────────

  describe("getActiveByOrderId", () => {
    it("returns active (non-terminal) payment with history", async () => {
      const payment = { ...makePayment(), statusHistory: [makeHistory()] }
      mockPaymentFindFirst.mockResolvedValue(payment)

      const result = await svc.getActiveByOrderId("order_01")

      expect(result).toEqual(payment)

      // Verify it filters terminal statuses
      const call = mockPaymentFindFirst.mock.calls[0][0]
      expect(call.where.orderId).toBe("order_01")
      expect(call.where.status.notIn).toContain("canceled")
      expect(call.where.status.notIn).toContain("refunded")
      expect(call.where.status.notIn).toContain("waived")
      expect(call.where.status.notIn).toContain("payment_failed")
      expect(call.where.status.notIn).toContain("payment_expired")
    })

    it("returns null when no active payment exists", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)

      const result = await svc.getActiveByOrderId("order_01")
      expect(result).toBeNull()
    })
  })

  // ── getActiveByOrderIds (N1PAY — batched active-payment lookup) ────────

  describe("getActiveByOrderIds", () => {
    it("returns the most-recent non-terminal payment per order in ONE query", async () => {
      // findMany returns all non-terminal payments, createdAt DESC (as the impl orders).
      const rows = [
        makePayment({ id: "pay_o1_new", orderId: "order_1", createdAt: new Date("2026-04-12T12:00:00Z") }),
        makePayment({ id: "pay_o1_old", orderId: "order_1", createdAt: new Date("2026-04-12T10:00:00Z") }),
        makePayment({ id: "pay_o2", orderId: "order_2", createdAt: new Date("2026-04-12T11:00:00Z") }),
      ]
      mockPaymentFindMany.mockResolvedValue(rows)

      const result = await svc.getActiveByOrderIds(["order_1", "order_2", "order_3"])

      // ONE batched query, not N (the N1PAY fix)
      expect(mockPaymentFindMany).toHaveBeenCalledTimes(1)
      const call = mockPaymentFindMany.mock.calls[0][0]
      expect(call.where.orderId).toEqual({ in: ["order_1", "order_2", "order_3"] })
      expect(call.orderBy).toEqual({ createdAt: "desc" })
      // Terminal statuses excluded — parity with getActiveByOrderId
      expect(call.where.status.notIn).toContain("canceled")
      expect(call.where.status.notIn).toContain("refunded")
      expect(call.where.status.notIn).toContain("waived")
      expect(call.where.status.notIn).toContain("payment_failed")
      expect(call.where.status.notIn).toContain("payment_expired")

      // Most-recent per order; an order with no active payment is absent
      expect(result.get("order_1")?.id).toBe("pay_o1_new")
      expect(result.get("order_2")?.id).toBe("pay_o2")
      expect(result.has("order_3")).toBe(false)
    })

    it("issues NO query and returns an empty map for an empty id list", async () => {
      const result = await svc.getActiveByOrderIds([])

      expect(result.size).toBe(0)
      expect(mockPaymentFindMany).not.toHaveBeenCalled()
    })

    it("matches getActiveByOrderId per order (most-recent non-terminal)", async () => {
      const newest = makePayment({ id: "pay_new", orderId: "order_x", createdAt: new Date("2026-04-12T15:00:00Z") })
      mockPaymentFindMany.mockResolvedValue([newest])

      const batched = await svc.getActiveByOrderIds(["order_x"])
      expect(batched.get("order_x")?.id).toBe("pay_new")
    })
  })

  // ── listByOrderId ────────────────────────────────────────────────────

  describe("listByOrderId", () => {
    it("returns paginated list and count", async () => {
      const payments = [makePayment(), makePayment({ id: "pay_02", status: "canceled" })]
      mockPaymentFindMany.mockResolvedValue(payments)
      mockPaymentCount.mockResolvedValue(2)

      const result = await svc.listByOrderId("order_01")

      expect(result.payments).toHaveLength(2)
      expect(result.count).toBe(2)
    })

    it("applies custom limit and offset", async () => {
      mockPaymentFindMany.mockResolvedValue([])
      mockPaymentCount.mockResolvedValue(0)

      await svc.listByOrderId("order_01", { limit: 5, offset: 10 })

      const findCall = mockPaymentFindMany.mock.calls[0][0]
      expect(findCall.take).toBe(5)
      expect(findCall.skip).toBe(10)
    })

    it("defaults to limit=20 offset=0", async () => {
      mockPaymentFindMany.mockResolvedValue([])
      mockPaymentCount.mockResolvedValue(0)

      await svc.listByOrderId("order_01")

      const findCall = mockPaymentFindMany.mock.calls[0][0]
      expect(findCall.take).toBe(20)
      expect(findCall.skip).toBe(0)
    })
  })

  // ── getStatusHistory ─────────────────────────────────────────────────

  describe("getStatusHistory", () => {
    it("returns chronological history entries", async () => {
      const history = [
        makeHistory({ version: 1, fromStatus: "awaiting_payment", toStatus: "awaiting_payment" }),
        makeHistory({ version: 2, fromStatus: "awaiting_payment", toStatus: "payment_pending" }),
      ]
      mockHistoryFindMany.mockResolvedValue(history)

      const result = await svc.getStatusHistory("pay_01")

      expect(result).toHaveLength(2)
      expect(mockHistoryFindMany).toHaveBeenCalledWith({
        where: { paymentId: "pay_01" },
        orderBy: { createdAt: "asc" },
        take: 50,
        skip: 0,
      })
    })

    it("applies custom limit and offset", async () => {
      mockHistoryFindMany.mockResolvedValue([])

      await svc.getStatusHistory("pay_01", { limit: 10, offset: 5 })

      const call = mockHistoryFindMany.mock.calls[0][0]
      expect(call.take).toBe(10)
      expect(call.skip).toBe(5)
    })
  })

  // ── getByStripePaymentIntentId ───────────────────────────────────────

  describe("getByStripePaymentIntentId", () => {
    it("returns payment when found by Stripe PI ID", async () => {
      const payment = makePayment()
      mockPaymentFindUnique.mockResolvedValue(payment)

      const result = await svc.getByStripePaymentIntentId("pi_test_123")

      expect(result).toEqual(payment)
      expect(mockPaymentFindUnique).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: "pi_test_123" },
      })
    })

    it("returns null when not found", async () => {
      mockPaymentFindUnique.mockResolvedValue(null)

      const result = await svc.getByStripePaymentIntentId("pi_nonexistent")
      expect(result).toBeNull()
    })
  })
})
