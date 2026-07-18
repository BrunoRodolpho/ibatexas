/**
 * Reservation modify helpers (CUS-053). The diff builder produces the MINIMAL
 * PATCH body (only changed fields), no-op edits yield an empty body, and the
 * submit helper bubbles the server's pt-BR { message } on a 400. Fetch is
 * mocked; getApiBase is stubbed to a fixed base.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetApiBase = vi.hoisted(() => vi.fn(() => "http://api.test"))
vi.mock("@/lib/api", () => ({ getApiBase: mockGetApiBase }))

import {
  specialRequestsEqual,
  buildModifyPayload,
  hasModifyChanges,
  fetchAvailabilitySlots,
  submitModify,
  toStrictSpecialRequests,
  type ModifiableReservation,
} from "../modify"

const original: ModifiableReservation = {
  partySize: 2,
  specialRequests: [{ type: "birthday", notes: "50 anos" }],
  timeSlot: { id: "slot-1", date: "2026-08-01", startTime: "19:30", durationMinutes: 90 },
}

describe("specialRequestsEqual", () => {
  it("is order-insensitive and compares type + notes", () => {
    expect(
      specialRequestsEqual(
        [{ type: "birthday" }, { type: "highchair" }],
        [{ type: "highchair" }, { type: "birthday" }],
      ),
    ).toBe(true)
    expect(
      specialRequestsEqual([{ type: "birthday", notes: "a" }], [{ type: "birthday", notes: "b" }]),
    ).toBe(false)
    expect(specialRequestsEqual([{ type: "birthday" }], [])).toBe(false)
  })
})

describe("buildModifyPayload", () => {
  it("returns an empty body for a no-op edit (same slot, size, requests)", () => {
    const body = buildModifyPayload(original, {
      selectedTimeSlotId: "slot-1",
      partySize: 2,
      specialRequests: [{ type: "birthday", notes: "50 anos" }],
    })
    expect(body).toEqual({})
    expect(hasModifyChanges(body)).toBe(false)
  })

  it("includes newTimeSlotId only when the slot differs from the original", () => {
    expect(
      buildModifyPayload(original, { selectedTimeSlotId: "slot-2", partySize: 2, specialRequests: original.specialRequests }),
    ).toEqual({ newTimeSlotId: "slot-2" })
    // undefined selected slot never sends newTimeSlotId
    expect(
      buildModifyPayload(original, { partySize: 2, specialRequests: original.specialRequests }),
    ).toEqual({})
  })

  it("includes newPartySize and specialRequests when they change", () => {
    const body = buildModifyPayload(original, {
      selectedTimeSlotId: "slot-1",
      partySize: 4,
      specialRequests: [{ type: "window_seat" }],
    })
    expect(body).toEqual({ newPartySize: 4, specialRequests: [{ type: "window_seat" }] })
    expect(hasModifyChanges(body)).toBe(true)
  })
})

describe("fetchAvailabilitySlots", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("requests the availability route and returns slots (defaults to [])", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: [{ timeSlotId: "s9" }] }) })
    vi.stubGlobal("fetch", fetchMock)
    const slots = await fetchAvailabilitySlots("2026-08-02", 3)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/reservations/availability?date=2026-08-02&partySize=3",
    )
    expect(slots).toEqual([{ timeSlotId: "s9" }])

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    expect(await fetchAvailabilitySlots("2026-08-02", 3)).toEqual([])
  })

  it("throws a pt-BR error on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    await expect(fetchAvailabilitySlots("2026-08-02", 3)).rejects.toThrow(
      "Erro ao buscar disponibilidade.",
    )
  })
})

describe("submitModify", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("PATCHes the body and returns the updated reservation", async () => {
    const updated = { id: "r1", partySize: 4 }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reservation: updated }) })
    vi.stubGlobal("fetch", fetchMock)

    const result = await submitModify("r1", { newPartySize: 4 })
    expect(result).toBe(updated)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/reservations/r1",
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        body: JSON.stringify({ newPartySize: 4 }),
      }),
    )
  })

  it("bubbles the server pt-BR message on a 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: "Horário indisponível." }) }),
    )
    await expect(submitModify("r1", { newTimeSlotId: "x" })).rejects.toThrow("Horário indisponível.")
  })

  it("falls back to a default message when the 400 body is unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new Error("no body") } }),
    )
    await expect(submitModify("r1", { newPartySize: 5 })).rejects.toThrow("Erro ao modificar reserva.")
  })
})

describe("toStrictSpecialRequests (build-fix: store loose type -> strict enum)", () => {
  it("maps all seven form literals through unchanged", () => {
    const loose = [
      { type: "birthday", notes: "50 anos" },
      { type: "anniversary" },
      { type: "allergy_warning", notes: "amendoim" },
      { type: "highchair" },
      { type: "window_seat" },
      { type: "accessible" },
      { type: "other", notes: "mesa quieta" },
    ]
    const strict = toStrictSpecialRequests(loose)
    expect(strict).toHaveLength(7)
    expect(strict.map((r) => r.type)).toEqual(loose.map((r) => r.type))
    expect(strict[0].notes).toBe("50 anos")
  })

  it("drops an unknown literal (type soundness, honest diff)", () => {
    expect(toStrictSpecialRequests([{ type: "not_a_request" }])).toEqual([])
  })
})
