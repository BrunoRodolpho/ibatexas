// Tests for the get_my_reservations tool WRAPPER.
//
// SCOPE. `getMyReservations` is a ~7-line wrapper (get-my-reservations.ts:8-18):
// it parses with `GetMyReservationsInputSchema`, constructs the service, and
// returns `svc.listByCustomer(customerId, { status, limit })` verbatim. That is
// all this file asserts.
//
// Two things were removed here:
//
//   1. A PHANTOM `vi.mock("../utils.js")` declaring `reservationToDTO`,
//      `assignTables` and `releaseReservation` — none of which exist in
//      utils.ts (whose only exports are `buildDateTime`, `formatDateBR` and
//      `locationLabel`). It was green solely because nothing in the SUT graph
//      imports that module, so the factory never ran and its three bogus names
//      were never checked against reality.
//
//   2. A re-implementation of `listByCustomer` inside the `@ibatexas/domain`
//      mock factory. Its where/orderBy/take assertions were reading back the
//      test's own construction, not production. The REAL `listByCustomer` —
//      including the FE-T17b `{ in: [...] }` array branch, the single-status
//      exact-match branch, and the pagination-burying regression — is genuinely
//      covered at the domain layer in
//      packages/domain/src/services/__tests__/reservation.test.ts:404-520.
//      This removes a vacuous mirror, not coverage.
//
// The service method is stubbed as a bare `vi.fn()`, matching the in-repo
// template used by cancel-reservation.test.ts, create-reservation.test.ts and
// join-waitlist.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { ReservationStatus } from "@ibatexas/types"
import { getMyReservations } from "../get-my-reservations.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockListByCustomer = vi.hoisted(() => vi.fn())
const mockCreateReservationService = vi.hoisted(() =>
  vi.fn(() => ({ listByCustomer: mockListByCustomer })),
)

vi.mock("@ibatexas/domain", () => ({
  createReservationService: mockCreateReservationService,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SERVICE_RESULT = {
  reservations: [
    { id: "res_01", customerId: "cus_01", partySize: 4, status: "confirmed" },
    { id: "res_02", customerId: "cus_01", partySize: 2, status: "cancelled" },
  ],
  total: 2,
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getMyReservations (tool wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListByCustomer.mockResolvedValue({ reservations: [], total: 0 })
  })

  it("returns the service result verbatim — no reshaping in the wrapper", async () => {
    mockListByCustomer.mockResolvedValue(SERVICE_RESULT)

    const result = await getMyReservations({ customerId: "cus_01", limit: 10 })

    expect(result).toBe(SERVICE_RESULT)
  })

  it("forwards customerId positionally and status/limit as the options bag", async () => {
    await getMyReservations({
      customerId: "cus_42",
      status: ReservationStatus.CONFIRMED,
      limit: 5,
    })

    expect(mockCreateReservationService).toHaveBeenCalledOnce()
    expect(mockListByCustomer).toHaveBeenCalledExactlyOnceWith("cus_42", {
      status: ReservationStatus.CONFIRMED,
      limit: 5,
    })
  })

  it("forwards status as undefined when the caller omits it (no filter)", async () => {
    await getMyReservations({ customerId: "cus_01", limit: 10 })

    expect(mockListByCustomer).toHaveBeenCalledExactlyOnceWith("cus_01", {
      status: undefined,
      limit: 10,
    })
  })

  // The wrapper's zod schema carries `.default(10)`, so the service is never
  // handed an undefined limit from this path — the default is applied HERE, by
  // the parse, not by the service's own `?? 10` fallback.
  it("applies the schema's default limit of 10 when the caller omits it", async () => {
    await getMyReservations({
      customerId: "cus_01",
    } as Parameters<typeof getMyReservations>[0])

    expect(mockListByCustomer).toHaveBeenCalledExactlyOnceWith("cus_01", {
      status: undefined,
      limit: 10,
    })
  })

  // ── The zod parse (the wrapper's other job) ─────────────────────────────────

  it.each([
    ["a non-string customerId", { customerId: 42, limit: 10 }],
    ["an unknown status", { customerId: "cus_01", status: "abducted", limit: 10 }],
    ["a limit below the minimum", { customerId: "cus_01", limit: 0 }],
    ["a limit above the maximum", { customerId: "cus_01", limit: 5000 }],
    ["a non-integer limit", { customerId: "cus_01", limit: 2.5 }],
  ])("rejects %s before touching the service", async (_label, input) => {
    await expect(
      getMyReservations(input as unknown as Parameters<typeof getMyReservations>[0]),
    ).rejects.toThrow()

    expect(mockCreateReservationService).not.toHaveBeenCalled()
    expect(mockListByCustomer).not.toHaveBeenCalled()
  })
})
