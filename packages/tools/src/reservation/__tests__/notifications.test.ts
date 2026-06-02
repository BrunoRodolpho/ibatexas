// Tests for reservation notifications — timezone safety
// Verifies that date-only strings don't produce off-by-one dates

import { describe, it, expect, vi, beforeEach } from "vitest"
import { ReservationStatus, TableLocation, type ReservationDTO, type WaitlistDTO } from "@ibatexas/types"
import { setToolsLogger } from "../../logger.js"
import {
  sendReservationConfirmation,
  notifyWaitlistSpotAvailable,
} from "../notifications.js"

// Capture structured log calls via the injected logger to verify payload content.
// notifications.ts now logs through @ibatexas/tools' StructuredLogger port; the
// stub/error payload is the first arg, the human message the second.
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
setToolsLogger(logger)

type StubPayload = {
  event: string
  phone_present: boolean
  customerId?: string
  message: string
}

const baseReservation: ReservationDTO = {
  id: "res_01",
  displayId: 1,
  customerId: "cust_01",
  partySize: 4,
  status: ReservationStatus.CONFIRMED,
  specialRequests: [],
  timeSlot: {
    id: "slot_01",
    date: "2026-03-15",
    startTime: "19:30",
    durationMinutes: 90,
  },
  tableLocation: TableLocation.INDOOR,
  confirmedAt: "2026-03-10T10:00:00Z",
  checkedInAt: null,
  cancelledAt: null,
  createdAt: "2026-03-10T10:00:00Z",
  updatedAt: "2026-03-10T10:00:00Z",
}

describe("sendReservationConfirmation", () => {
  beforeEach(() => {
    logger.warn.mockClear()
  })

  it("logs a WhatsApp confirmation message (no raw phone — LGPD)", async () => {
    await sendReservationConfirmation(baseReservation, "+5511999999999")

    expect(logger.warn).toHaveBeenCalledOnce()
    const payload = logger.warn.mock.calls[0]![0] as StubPayload
    expect(payload.event).toBe("whatsapp_stub")
    // The raw phone must never be logged — only a presence boolean.
    expect(payload.phone_present).toBe(true)
    expect(payload.customerId).toBe("cust_01")
    expect(JSON.stringify(payload)).not.toContain("+5511999999999")
    expect(payload.message).toContain("Reserva confirmada")
    expect(payload.message).toContain("19:30")
    expect(payload.message).toContain("4 pessoas")
  })

  it("date string does NOT show previous day (timezone safety)", async () => {
    // The bug: "2026-03-15" parsed as midnight UTC becomes March 14 in São Paulo (UTC-3)
    // Fix: appending T12:00:00Z before parsing prevents the off-by-one
    await sendReservationConfirmation(baseReservation)

    const payload = logger.warn.mock.calls[0]![0] as StubPayload
    // Should contain "15" (the correct day), not "14"
    expect(payload.message).toMatch(/15/)
    expect(payload.message).not.toMatch(/14 de março/)
  })

  it("logs phone_present=false and customerId when phone not provided", async () => {
    await sendReservationConfirmation(baseReservation)

    const payload = logger.warn.mock.calls[0]![0] as StubPayload
    expect(payload.phone_present).toBe(false)
    expect(payload.customerId).toBe("cust_01")
  })

  it("single person uses singular form", async () => {
    const solo = { ...baseReservation, partySize: 1 }
    await sendReservationConfirmation(solo)

    const payload = logger.warn.mock.calls[0]![0] as StubPayload
    expect(payload.message).toContain("1 pessoa")
    expect(payload.message).not.toContain("pessoas")
  })
})

describe("notifyWaitlistSpotAvailable", () => {
  const baseWaitlist: WaitlistDTO = {
    id: "wl_01",
    customerId: "cust_02",
    timeSlotId: "slot_01",
    partySize: 2,
    position: 1,
    notifiedAt: null,
    expiresAt: "2026-03-15T20:00:00Z",
    createdAt: "2026-03-14T10:00:00Z",
  }

  beforeEach(() => {
    logger.warn.mockClear()
  })

  it("logs a waitlist notification message", async () => {
    await notifyWaitlistSpotAvailable(baseWaitlist, "2026-03-15", "19:30")

    expect(logger.warn).toHaveBeenCalledOnce()
    const payload = logger.warn.mock.calls[0]![0] as StubPayload
    expect(payload.message).toContain("Vaga disponível")
    expect(payload.message).toContain("19:30")
    expect(payload.message).toContain("30 minutos")
  })

  it("date does NOT show previous day (timezone safety)", async () => {
    await notifyWaitlistSpotAvailable(baseWaitlist, "2026-03-15", "19:30")

    const payload = logger.warn.mock.calls[0]![0] as StubPayload
    expect(payload.message).toMatch(/15/)
  })
})
