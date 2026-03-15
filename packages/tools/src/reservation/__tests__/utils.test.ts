// Unit tests for reservation/utils.ts — pure function tests (no DB)

import { describe, it, expect } from "vitest"
import { reservationToDTO, buildDateTime, formatDateBR, locationLabel } from "../utils.js"
import { ReservationStatus } from "@ibatexas/types"
import type { ReservationWithRelations } from "../utils.js"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeReservation(overrides: Partial<ReservationWithRelations> = {}): ReservationWithRelations {
  return {
    id: "res_01",
    customerId: "cust_01",
    partySize: 4,
    status: ReservationStatus.CONFIRMED,
    specialRequests: [{ type: "high_chair", notes: "1 cadeirão" }],
    timeSlot: {
      id: "slot_01",
      date: new Date("2025-12-20"),
      startTime: "19:30",
      durationMinutes: 90,
      maxCovers: 50,
      reservedCovers: 10,
      createdAt: new Date("2025-01-01"),
    },
    tables: [
      {
        reservationId: "res_01",
        tableId: "tbl_01",
        table: {
          id: "tbl_01",
          number: "A1",
          capacity: 4,
          location: "indoor",
          active: true,
          createdAt: new Date("2025-01-01"),
        },
      },
    ],
    confirmedAt: new Date("2025-12-15T10:00:00Z"),
    checkedInAt: null,
    cancelledAt: null,
    createdAt: new Date("2025-12-15T10:00:00Z"),
    updatedAt: new Date("2025-12-15T10:00:00Z"),
    timeSlotId: "slot_01",
    ...overrides,
  }
}

// ── reservationToDTO ──────────────────────────────────────────────────────────

describe("reservationToDTO", () => {
  it("maps all fields correctly", () => {
    const dto = reservationToDTO(makeReservation())

    expect(dto.id).toBe("res_01")
    expect(dto.customerId).toBe("cust_01")
    expect(dto.partySize).toBe(4)
    expect(dto.status).toBe(ReservationStatus.CONFIRMED)
    expect(dto.specialRequests).toEqual([{ type: "high_chair", notes: "1 cadeirão" }])
    expect(dto.timeSlot.startTime).toBe("19:30")
    expect(dto.timeSlot.durationMinutes).toBe(90)
    expect(dto.tableLocation).toBe("indoor")
    expect(dto.confirmedAt).toBeDefined()
    expect(dto.checkedInAt).toBeNull()
    expect(dto.cancelledAt).toBeNull()
  })

  it("returns null tableLocation when no tables assigned", () => {
    const dto = reservationToDTO(makeReservation({ tables: [] }))
    expect(dto.tableLocation).toBeNull()
  })

  it("handles null specialRequests gracefully", () => {
    const dto = reservationToDTO(makeReservation({ specialRequests: null }))
    expect(dto.specialRequests).toEqual([])
  })

  it("formats dates as ISO strings", () => {
    const dto = reservationToDTO(makeReservation())
    expect(dto.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(dto.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("extracts date portion from timeSlot.date", () => {
    const dto = reservationToDTO(makeReservation())
    expect(dto.timeSlot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ── buildDateTime ─────────────────────────────────────────────────────────────

describe("buildDateTime", () => {
  it("combines date and startTime into ISO format", () => {
    const result = buildDateTime(new Date("2025-12-20"), "19:30")
    expect(result).toBe("2025-12-20T19:30:00")
  })

  it("handles midnight correctly", () => {
    const result = buildDateTime(new Date("2025-12-20"), "00:00")
    expect(result).toBe("2025-12-20T00:00:00")
  })
})

// ── formatDateBR ──────────────────────────────────────────────────────────────

describe("formatDateBR", () => {
  it("returns a pt-BR formatted date string", () => {
    // Use noon UTC to avoid timezone date shift (São Paulo is UTC-3)
    const result = formatDateBR(new Date("2025-12-20T12:00:00Z"))
    // Should contain Portuguese day/month words
    expect(result).toMatch(/dezembro/i)
    expect(result).toMatch(/2025/)
  })

  it("includes weekday", () => {
    // Use noon UTC to avoid timezone date shift (São Paulo is UTC-3)
    const result = formatDateBR(new Date("2025-12-20T12:00:00Z")) // Saturday in São Paulo
    expect(result).toMatch(/sábado/i)
  })
})

// ── locationLabel ─────────────────────────────────────────────────────────────

describe("locationLabel", () => {
  it("returns 'salão interno' for 'indoor'", () => {
    expect(locationLabel("indoor")).toBe("salão interno")
  })

  it("returns 'área externa' for 'outdoor'", () => {
    expect(locationLabel("outdoor")).toBe("área externa")
  })

  it("returns 'balcão do bar' for 'bar'", () => {
    expect(locationLabel("bar")).toBe("balcão do bar")
  })

  it("returns 'terraço' for 'terrace'", () => {
    expect(locationLabel("terrace")).toBe("terraço")
  })

  it("returns 'salão' for null", () => {
    expect(locationLabel(null)).toBe("salão")
  })

  it("returns the raw value for unknown locations", () => {
    expect(locationLabel("balcony")).toBe("balcony")
  })
})
