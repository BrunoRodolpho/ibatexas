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
