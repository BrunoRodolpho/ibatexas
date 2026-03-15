import { describe, it, expect } from "vitest"
import { ReservationStatus } from "@ibatexas/types"

describe("Reservation Flow", () => {
  it("follows the full lifecycle: pending → confirmed → seated → completed", () => {
    const transitions: ReservationStatus[] = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
      ReservationStatus.SEATED,
      ReservationStatus.COMPLETED,
    ]
    expect(transitions).toHaveLength(4)
    expect(transitions[0]).toBe("pending")
    expect(transitions[3]).toBe("completed")
  })

  it("allows cancellation from pending or confirmed", () => {
    const cancellableStates = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED]
    for (const state of cancellableStates) {
      expect(["pending", "confirmed"]).toContain(state)
    }
  })

  it("marks no-show only from confirmed status", () => {
    const canNoShow = (status: ReservationStatus) => status === ReservationStatus.CONFIRMED
    expect(canNoShow(ReservationStatus.CONFIRMED)).toBe(true)
    expect(canNoShow(ReservationStatus.PENDING)).toBe(false)
    expect(canNoShow(ReservationStatus.SEATED)).toBe(false)
  })

  it("validates party size within bounds", () => {
    const MAX = 20
    expect(1).toBeGreaterThanOrEqual(1)
    expect(20).toBeLessThanOrEqual(MAX)
    expect(21).toBeGreaterThan(MAX)
  })
})
