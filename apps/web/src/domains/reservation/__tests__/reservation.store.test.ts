/**
 * Reservation store — modify-mode actions (CUS-053). Verifies the store seams
 * the modify flow needs: entering modify mode seeds the shared form + baselines
 * the current slot (so an untouched time yields no diff), applyModified swaps
 * only the edited row while leaving modify mode, and cancel/reset clear the
 * modify state without clobbering the reservations list. Pure zustand via
 * getState()/setState() — no DOM.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { useReservationStore } from "../reservation.store"
import { ReservationStatus, type ReservationDTO } from "@ibatexas/types"

const RES: ReservationDTO = {
  id: "r1",
  displayId: 101,
  customerId: "cus_1",
  partySize: 3,
  status: ReservationStatus.CONFIRMED,
  specialRequests: [{ type: "birthday", notes: "40 anos" } as ReservationDTO["specialRequests"][number]],
  timeSlot: { id: "slot-1", date: "2026-08-10", startTime: "20:00", durationMinutes: 90 },
  tableLocation: null,
  confirmedAt: null,
  checkedInAt: null,
  cancelledAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
}

beforeEach(() => useReservationStore.getState().reset())

describe("startModify (CUS-053)", () => {
  it("seeds the shared form and baselines selectedSlot with the current slot", () => {
    useReservationStore.getState().startModify(RES)
    const s = useReservationStore.getState()
    expect(s.modifyOriginal).toBe(RES)
    expect(s.selectedDate).toBe("2026-08-10")
    expect(s.partySize).toBe(3)
    expect(s.specialRequests).toEqual(RES.specialRequests)
    expect(s.selectedSlot?.timeSlotId).toBe("slot-1")
    expect(s.showSlotPicker).toBe(false)
    expect(s.modifyError).toBeNull()
  })

  it("does not touch the myReservations list", () => {
    useReservationStore.getState().setMyReservations([RES], false)
    useReservationStore.getState().startModify(RES)
    expect(useReservationStore.getState().myReservations).toEqual([RES])
  })
})

describe("applyModified (CUS-053)", () => {
  it("replaces only the edited row and leaves modify mode", () => {
    const other: ReservationDTO = { ...RES, id: "r2", displayId: 102 }
    useReservationStore.getState().setMyReservations([RES, other], false)
    useReservationStore.getState().startModify(RES)

    const updated: ReservationDTO = { ...RES, partySize: 6 }
    useReservationStore.getState().applyModified(updated)

    const s = useReservationStore.getState()
    expect(s.myReservations).toEqual([updated, other])
    expect(s.modifyOriginal).toBeNull()
    expect(s.selectedSlot).toBeNull()
  })
})

describe("modify field setters + cancel (CUS-053)", () => {
  it("sets picker/submitting/error flags and cancel clears them", () => {
    const g = () => useReservationStore.getState()
    g().startModify(RES)
    g().setShowSlotPicker(true)
    g().setModifySubmitting(true)
    g().setModifyError("boom")
    expect(g().showSlotPicker).toBe(true)
    expect(g().modifySubmitting).toBe(true)
    expect(g().modifyError).toBe("boom")

    useReservationStore.getState().setMyReservations([RES], false)
    g().cancelModify()
    const s = g()
    expect(s.modifyOriginal).toBeNull()
    expect(s.modifyError).toBeNull()
    expect(s.showSlotPicker).toBe(false)
    expect(s.selectedSlot).toBeNull()
    // list survives a cancel
    expect(s.myReservations).toEqual([RES])
  })
})
