// Tests for the check_table_availability tool WRAPPER.
//
// SCOPE. `checkTableAvailability` is a ~6-line wrapper (check-availability.ts:12-26).
// Everything it owns is asserted here and nothing else:
//   1. the `CheckAvailabilityInputSchema` zod parse,
//   2. constructing the service and forwarding the three POSITIONAL args,
//   3. passing the service's slots through untouched,
//   4. the two pt-BR messages (empty vs non-empty) and their interpolation.
//
// The availability ALGORITHM is not this file's business and is no longer
// simulated here. This suite previously `vi.mock`ed `@ibatexas/domain` with no
// `importOriginal` — so the domain package never loaded — and RE-IMPLEMENTED
// `checkAvailability` inside its own mock factory. Its six test names claimed
// capacity exclusion, preferredTime filtering, reserved-table exclusion and
// location dedup, but every assertion read back the test's own construction; the
// real `ReservationService.checkAvailability` was never executed by ANY test in
// the repo. It had also drifted: it pinned a per-slot
// `table.findMany({ where: { id: { notIn: [...] } } })` that production stopped
// issuing when it moved to a single bulk `{ active: true }` fetch plus a JS
// filter — green only because the test itself issued the call it asserted on.
//
// Those four behaviours now have REAL coverage against the real algorithm in
// packages/domain/src/services/__tests__/reservation.test.ts
// (`describe("ReservationService.checkAvailability")`), where killing the
// production body turns 10 tests RED.
//
// The service method is stubbed here as a bare `vi.fn()`, matching the in-repo
// template used by cancel-reservation.test.ts, create-reservation.test.ts and
// join-waitlist.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { checkTableAvailability } from "../check-availability.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockCheckAvailability = vi.hoisted(() => vi.fn())
const mockCreateReservationService = vi.hoisted(() =>
  vi.fn(() => ({ checkAvailability: mockCheckAvailability })),
)

vi.mock("@ibatexas/domain", () => ({
  createReservationService: mockCreateReservationService,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const DATE = "2026-03-15"

const SLOT_A = {
  timeSlotId: "ts_lunch",
  date: DATE,
  startTime: "12:00",
  durationMinutes: 90,
  availableCovers: 40,
  tableLocations: ["indoor", "outdoor"],
}

const SLOT_B = {
  timeSlotId: "ts_dinner",
  date: DATE,
  startTime: "19:30",
  durationMinutes: 90,
  availableCovers: 30,
  tableLocations: ["indoor"],
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("checkTableAvailability (tool wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckAvailability.mockResolvedValue([])
  })

  it("forwards date, partySize and preferredTime to the service as POSITIONAL args", async () => {
    await checkTableAvailability({ date: DATE, partySize: 4, preferredTime: "19:30" })

    expect(mockCreateReservationService).toHaveBeenCalledOnce()
    expect(mockCheckAvailability).toHaveBeenCalledExactlyOnceWith(DATE, 4, "19:30")
  })

  it("passes preferredTime as undefined when the caller omits it", async () => {
    await checkTableAvailability({ date: DATE, partySize: 2 })

    expect(mockCheckAvailability).toHaveBeenCalledExactlyOnceWith(DATE, 2, undefined)
  })

  it("returns the service's slots unchanged", async () => {
    mockCheckAvailability.mockResolvedValue([SLOT_A, SLOT_B])

    const result = await checkTableAvailability({ date: DATE, partySize: 4 })

    expect(result.slots).toEqual([SLOT_A, SLOT_B])
  })

  it("builds the pt-BR found-message from the slot COUNT and the parsed input", async () => {
    mockCheckAvailability.mockResolvedValue([SLOT_A, SLOT_B])

    const result = await checkTableAvailability({ date: DATE, partySize: 4 })

    expect(result.message).toBe(
      `Encontrei 2 horário(s) disponível(is) para 4 pessoa(s) em ${DATE}.`,
    )
  })

  it("builds the pt-BR not-found message when the service returns no slots", async () => {
    mockCheckAvailability.mockResolvedValue([])

    const result = await checkTableAvailability({ date: DATE, partySize: 6 })

    expect(result.slots).toEqual([])
    expect(result.message).toBe(
      `Não encontrei vagas para 6 pessoa(s) em ${DATE}. Tente outra data.`,
    )
  })

  // ── The zod parse (the wrapper's other job) ─────────────────────────────────

  it.each([
    ["malformed date", { date: "15/03/2026", partySize: 2 }],
    ["party size below the minimum", { date: DATE, partySize: 0 }],
    ["non-integer party size", { date: DATE, partySize: 2.5 }],
    ["party size above the maximum", { date: DATE, partySize: 999 }],
    ["malformed preferredTime", { date: DATE, partySize: 2, preferredTime: "7pm" }],
  ])("rejects %s before touching the service", async (_label, input) => {
    await expect(
      checkTableAvailability(input as Parameters<typeof checkTableAvailability>[0]),
    ).rejects.toThrow()

    expect(mockCreateReservationService).not.toHaveBeenCalled()
    expect(mockCheckAvailability).not.toHaveBeenCalled()
  })
})
