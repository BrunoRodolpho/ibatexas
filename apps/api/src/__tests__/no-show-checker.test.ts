// Tests for no-show-checker job
// Mocks Prisma and NATS to test the checking logic without DB.
// Tests call the exported checkNoShows() processor directly (BullMQ is mocked).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { IntentEnvelope } from "@adjudicate/core"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { checkNoShows, startNoShowChecker, stopNoShowChecker } from "../jobs/no-show-checker.js"

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFindConfirmedForDate = vi.fn()
const mockTransitionFromEnvelope = vi.fn()

vi.mock("@ibatexas/domain", () => ({
  createReservationService: () => ({
    findConfirmedForDate: (...args: unknown[]) => mockFindConfirmedForDate(...args),
    transitionFromEnvelope: (...args: unknown[]) =>
      mockTransitionFromEnvelope(...args),
  }),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}))

vi.mock("../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}))

describe("no-show checker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await stopNoShowChecker()
    vi.useRealTimers()
  })

  it("starts and stops without errors", async () => {
    expect(() => startNoShowChecker()).not.toThrow()
    await expect(stopNoShowChecker()).resolves.toBeUndefined()
  })

  it("does not start twice", () => {
    expect(() => startNoShowChecker()).not.toThrow()
    expect(() => startNoShowChecker()).not.toThrow() // second call should be a no-op
  })

  it("marks past confirmed reservations as no_show via envelope (P1-J)", async () => {
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

    mockFindConfirmedForDate.mockResolvedValue([reservation])
    mockTransitionFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: undefined,
    })

    // Set "now" well past 11:30 + even worst-case TZ offset + 15 min grace
    vi.setSystemTime(new Date("2026-03-15T23:59:00Z"))

    await checkNoShows()

    expect(mockTransitionFromEnvelope).toHaveBeenCalledOnce()
    const [envelope, state] = mockTransitionFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
      { ctx: Record<string, unknown> },
    ]
    expect(envelope.kind).toBe("reservation.no_show.mark")
    expect(envelope.actor.principal).toBe("system")
    expect(envelope.taint).toBe("SYSTEM")
    // nonce is deterministic per reservation — idempotent across retries.
    expect(envelope.nonce).toBe("noshow:res_01")
    expect(envelope.payload).toEqual({ reservationId: "res_01" })
    expect(state.ctx.reservation).toMatchObject({
      id: "res_01",
      status: "confirmed",
      partySize: 4,
      timeSlotId: "slot_01",
    })

    expect(publishNatsEvent).toHaveBeenCalledWith(
      "reservation.no_show",
      expect.objectContaining({
        eventType: "reservation.no_show",
        metadata: { reservationId: "res_01" },
      }),
    )

    delete process.env.RESTAURANT_TIMEZONE
  })

  it("skips the NATS publish when kernel does not authorize the mark", async () => {
    process.env.RESTAURANT_TIMEZONE = "UTC"
    const pastSlotDate = new Date("2026-03-15T00:00:00.000Z")
    const reservation = {
      id: "res_refused",
      customerId: "cust_05",
      partySize: 2,
      status: "confirmed",
      timeSlotId: "slot_05",
      timeSlot: {
        id: "slot_05",
        date: pastSlotDate,
        startTime: "11:30",
        durationMinutes: 90,
        maxCovers: 80,
        reservedCovers: 2,
      },
    }
    mockFindConfirmedForDate.mockResolvedValue([reservation])
    mockTransitionFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: { code: "reservation.not_modifiable", userFacing: "..." },
        basis: [],
      },
    })
    vi.setSystemTime(new Date("2026-03-15T23:59:00Z"))

    await checkNoShows()

    // Kernel was invoked but the no-show publish must NOT have fired.
    expect(mockTransitionFromEnvelope).toHaveBeenCalledOnce()
    expect(publishNatsEvent).not.toHaveBeenCalled()
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

    mockFindConfirmedForDate.mockResolvedValue([reservation])

    // Set "now" to 2026-03-15 19:00 UTC (before 20:00 slot)
    vi.setSystemTime(new Date("2026-03-15T19:00:00Z"))

    await checkNoShows()

    // Should NOT mark as no_show — envelope path NOT invoked.
    expect(mockTransitionFromEnvelope).not.toHaveBeenCalled()

    delete process.env.RESTAURANT_TIMEZONE
  })

  it("handles errors gracefully", async () => {
    mockFindConfirmedForDate.mockRejectedValue(new Error("DB connection lost"))

    await expect(checkNoShows()).rejects.toThrow("DB connection lost")
  })
})
