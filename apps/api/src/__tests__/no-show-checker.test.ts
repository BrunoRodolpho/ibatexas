// Tests for no-show-checker job
// Mocks Prisma and NATS to test the checking logic without DB

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFindMany = vi.fn()
const mockUpdate = vi.fn()
const mockTimeSlotUpdate = vi.fn()
const mockDeleteMany = vi.fn()
const mockTransaction = vi.fn()

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    timeSlot: {
      update: (...args: unknown[]) => mockTimeSlotUpdate(...args),
    },
    reservationTable: {
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}))

import { startNoShowChecker, stopNoShowChecker } from "../jobs/no-show-checker.js"
import { publishNatsEvent } from "@ibatexas/nats-client"

describe("no-show checker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopNoShowChecker()
    vi.useRealTimers()
  })

  it("starts and stops without errors", () => {
    mockFindMany.mockResolvedValue([])

    startNoShowChecker()
    stopNoShowChecker()
  })

  it("does not start twice", () => {
    mockFindMany.mockResolvedValue([])

    startNoShowChecker()
    startNoShowChecker() // second call should be a no-op

    stopNoShowChecker()
  })

  it("marks past confirmed reservations as no_show", async () => {
    // Set timezone to UTC for predictable testing
    process.env.RESTAURANT_TIMEZONE = "UTC"

    // Reservation at 11:30 UTC
    const pastSlotDate = new Date("2026-03-15T00:00:00.000Z")
    const reservation = {
      id: "res_01",
      customerId: "cust_01",
      partySize: 4,
      status: "confirmed",
      timeSlotId: "slot_01",
      timeSlot: {
        id: "slot_01",
        date: pastSlotDate,
        startTime: "11:30",
        durationMinutes: 90,
        maxCovers: 80,
        reservedCovers: 4,
      },
    }

    mockFindMany.mockResolvedValue([reservation])
    mockUpdate.mockResolvedValue({})
    mockTimeSlotUpdate.mockResolvedValue({})
    mockDeleteMany.mockResolvedValue({ count: 0 })
    mockTransaction.mockResolvedValue([])

    // Set "now" well past 11:30 + even worst-case TZ offset + 15 min grace
    // The slotToLocalDate function creates `new Date("2026-03-15T11:30:00")` (no Z)
    // which is parsed as local time. To be safe, use 23:59 UTC.
    vi.setSystemTime(new Date("2026-03-15T23:59:00Z"))

    startNoShowChecker()

    // Wait for initial async check to complete
    await vi.advanceTimersByTimeAsync(200)

    expect(mockTransaction).toHaveBeenCalledOnce()
    expect(publishNatsEvent).toHaveBeenCalledWith(
      "reservation.no_show",
      expect.objectContaining({
        eventType: "reservation.no_show",
        metadata: { reservationId: "res_01" },
      }),
    )

    delete process.env.RESTAURANT_TIMEZONE
  })

  it("does not mark future reservations as no_show", async () => {
    process.env.RESTAURANT_TIMEZONE = "UTC"

    const futureSlotDate = new Date("2026-03-15T00:00:00.000Z")
    const reservation = {
      id: "res_02",
      customerId: "cust_02",
      partySize: 2,
      status: "confirmed",
      timeSlotId: "slot_02",
      timeSlot: {
        id: "slot_02",
        date: futureSlotDate,
        startTime: "20:00",
        durationMinutes: 90,
        maxCovers: 80,
        reservedCovers: 2,
      },
    }

    mockFindMany.mockResolvedValue([reservation])

    // Set "now" to 2026-03-15 19:00 UTC (before 20:00 slot)
    vi.setSystemTime(new Date("2026-03-15T19:00:00Z"))

    startNoShowChecker()
    await vi.advanceTimersByTimeAsync(200)

    // Should NOT mark as no_show
    expect(mockTransaction).not.toHaveBeenCalled()

    delete process.env.RESTAURANT_TIMEZONE
  })

  it("handles errors gracefully", async () => {
    mockFindMany.mockRejectedValue(new Error("DB connection lost"))

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    startNoShowChecker()
    await vi.advanceTimersByTimeAsync(100)

    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })
})
