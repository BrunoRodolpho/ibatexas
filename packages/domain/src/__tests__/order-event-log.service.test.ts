// Tests for OrderEventLogService
// Mock-based; no DB required.
//
// Scenarios:
// - append: happy path — upserts with correct idempotency key
// - append: duplicate — upsert no-op (update: {})
// - append: DB error — fire-and-forget (logs, never throws)
// - getByOrderId: ordering + pagination
// - getByEventType: ordering + pagination

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockUpsert = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())

vi.mock("../client.js", () => ({
  prisma: {
    orderEventLog: {
      upsert: mockUpsert,
      findMany: mockFindMany,
    },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import { createOrderEventLogService } from "../services/order-event-log.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order_01",
    eventType: "order.placed",
    discriminator: "v1",
    payload: { foo: "bar" },
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_01",
    orderId: "order_01",
    eventType: "order.placed",
    idempotencyKey: "order_01:order.placed:v1",
    payload: { foo: "bar" },
    timestamp: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OrderEventLogService", () => {
  beforeEach(() => vi.clearAllMocks())

  // ── append ────────────────────────────────────────────────────────────

  describe("append", () => {
    it("upserts with correct composite idempotency key", async () => {
      mockUpsert.mockResolvedValue({})
      const svc = createOrderEventLogService()

      await svc.append(makeInput())

      expect(mockUpsert).toHaveBeenCalledOnce()
      const call = mockUpsert.mock.calls[0][0]
      expect(call.where.idempotencyKey).toBe("order_01:order.placed:v1")
      expect(call.create.orderId).toBe("order_01")
      expect(call.create.eventType).toBe("order.placed")
      expect(call.update).toEqual({}) // immutable — no-op on duplicate
    })

    it("duplicate upsert is a no-op (update: {})", async () => {
      mockUpsert.mockResolvedValue({})
      const svc = createOrderEventLogService()

      await svc.append(makeInput())
      await svc.append(makeInput())

      expect(mockUpsert).toHaveBeenCalledTimes(2)
      // Both calls have empty update — duplicates are harmless
      expect(mockUpsert.mock.calls[0][0].update).toEqual({})
      expect(mockUpsert.mock.calls[1][0].update).toEqual({})
    })

    it("logs error but never throws on DB failure", async () => {
      mockUpsert.mockRejectedValue(new Error("DB connection lost"))
      const mockLog = { warn: vi.fn(), error: vi.fn() }
      const svc = createOrderEventLogService(mockLog)

      // Should NOT throw
      await expect(svc.append(makeInput())).resolves.toBeUndefined()
      expect(mockLog.error).toHaveBeenCalledOnce()
    })

    it("does not throw even without a logger", async () => {
      mockUpsert.mockRejectedValue(new Error("DB connection lost"))
      const svc = createOrderEventLogService() // no logger

      await expect(svc.append(makeInput())).resolves.toBeUndefined()
    })
  })

  // ── getByOrderId ──────────────────────────────────────────────────────

  describe("getByOrderId", () => {
    it("queries with default limit and asc ordering", async () => {
      mockFindMany.mockResolvedValue([makeRow()])
      const svc = createOrderEventLogService()

      const result = await svc.getByOrderId("order_01")

      expect(result).toHaveLength(1)
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { orderId: "order_01" },
        orderBy: { timestamp: "asc" },
        take: 100,
        skip: 0,
      })
    })

    it("respects custom limit and offset", async () => {
      mockFindMany.mockResolvedValue([])
      const svc = createOrderEventLogService()

      await svc.getByOrderId("order_01", { limit: 10, offset: 5 })

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 5 }),
      )
    })
  })

  // ── getByEventType ────────────────────────────────────────────────────

  describe("getByEventType", () => {
    it("queries with default limit and desc ordering", async () => {
      mockFindMany.mockResolvedValue([makeRow()])
      const svc = createOrderEventLogService()

      const result = await svc.getByEventType("order.placed")

      expect(result).toHaveLength(1)
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { eventType: "order.placed" },
        orderBy: { timestamp: "desc" },
        take: 50,
        skip: 0,
      })
    })

    it("respects custom limit and offset", async () => {
      mockFindMany.mockResolvedValue([])
      const svc = createOrderEventLogService()

      await svc.getByEventType("order.placed", { limit: 25, offset: 10 })

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25, skip: 10 }),
      )
    })
  })
})
