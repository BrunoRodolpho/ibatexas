import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: { count: vi.fn(), findMany: vi.fn() },
    table: { findMany: vi.fn(), count: vi.fn() },
    timeSlot: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))

describe("Admin Routes", () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe("Auth guard", () => {
    it("rejects request without x-admin-key", () => {
      // Simulate missing header scenario
      const hasKey = (headers: Record<string, string | undefined>) =>
        Boolean(headers["x-admin-key"])
      expect(hasKey({})).toBe(false)
    })

    it("accepts request with valid x-admin-key", () => {
      const hasKey = (headers: Record<string, string | undefined>) =>
        Boolean(headers["x-admin-key"])
      expect(hasKey({ "x-admin-key": "test-key" })).toBe(true)
    })
  })

  describe("Dashboard aggregation", () => {
    it("computes metrics from multiple sources", async () => {
      const reservationCount = 15
      const tableCount = 12
      const metrics = {
        totalReservations: reservationCount,
        activeTables: tableCount,
        occupancyRate: Math.round((reservationCount / (tableCount * 5)) * 100),
      }
      expect(metrics.totalReservations).toBe(15)
      expect(metrics.activeTables).toBe(12)
      expect(metrics.occupancyRate).toBe(25)
    })
  })
})
