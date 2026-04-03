// Tests for create_reservation tool
// Mock-based; no database required.
//
// Scenarios:
// - Slot not found → throws
// - Insufficient capacity → throws
// - Happy path → creates reservation, publishes NATS, returns confirmation
// - WhatsApp stub is called with correct reservation DTO

import { describe, it, expect, beforeEach, vi } from "vitest"
import { createReservation } from "../create-reservation.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn())
const mockTableFindMany = vi.hoisted(() => vi.fn())
const mockReservationTableFindMany = vi.hoisted(() => vi.fn())
const mockTransaction = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockSendReservationConfirmation = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    timeSlot: { findUnique: mockTimeSlotFindUnique },
    table: { findMany: mockTableFindMany },
    reservationTable: { findMany: mockReservationTableFindMany },
    $transaction: mockTransaction,
  },
  createReservationService: () => ({
    create: async (input: { customerId: string; timeSlotId: string; partySize: number; specialRequests?: unknown[] }) => {
      const slot = await mockTimeSlotFindUnique({ where: { id: input.timeSlotId } })
      if (!slot) throw new Error("Horário não encontrado. Verifique o ID do horário.")
      const availableCovers = slot.maxCovers - slot.reservedCovers
      if (availableCovers < input.partySize) {
        throw new Error(`Este horário está esgotado para ${input.partySize} pessoa(s). Tente outro horário ou entre na lista de espera.`)
      }
      const reserved = await mockReservationTableFindMany({
        where: { reservation: { timeSlotId: input.timeSlotId, status: { notIn: ["cancelled", "no_show"] } } },
        select: { tableId: true },
      })
      const reservedIds = new Set(reserved.map((rt: { tableId: string }) => rt.tableId))
      const available = await mockTableFindMany({
        where: { active: true, id: { notIn: Array.from(reservedIds) } },
        orderBy: { capacity: "desc" },
      })
      const tableIds: string[] = []
      let covered = 0
      for (const table of available) {
        if (covered >= input.partySize) break
        tableIds.push(table.id)
        covered += table.capacity
      }
      const tableLocation = available[0]?.location ?? null
      const reservation = await mockTransaction(async (tx: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>) => {
        const r = await tx.reservation.create({
          data: {
            customerId: input.customerId,
            partySize: input.partySize,
            status: "confirmed",
            specialRequests: input.specialRequests ?? [],
            confirmedAt: new Date(),
            timeSlotId: input.timeSlotId,
            tables: { create: tableIds.map((tableId: string) => ({ tableId })) },
          },
          include: { timeSlot: true, tables: { include: { table: true } } },
        })
        await tx.timeSlot.update({
          where: { id: input.timeSlotId },
          data: { reservedCovers: { increment: input.partySize } },
        })
        return r
      })
      const toDTO = (r: Record<string, unknown>) => {
        const ts = r.timeSlot as Record<string, unknown>
        const tables = r.tables as Array<{ table: { location: string } }>
        return {
          id: r.id, customerId: r.customerId, partySize: r.partySize,
          status: r.status, specialRequests: r.specialRequests ?? [],
          timeSlot: {
            id: ts.id, date: (ts.date as Date).toISOString().split("T")[0] ?? "",
            startTime: ts.startTime, durationMinutes: ts.durationMinutes,
          },
          tableLocation: tables?.[0]?.table?.location ?? null,
          confirmedAt: r.confirmedAt ? (r.confirmedAt as Date).toISOString() : null,
          checkedInAt: null, cancelledAt: null,
          createdAt: (r.createdAt as Date).toISOString(),
          updatedAt: (r.updatedAt as Date).toISOString(),
        }
      }
      return { reservation: toDTO(reservation as Record<string, unknown>), tableLocation }
    },
  }),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// Mock notifications stub
vi.mock("../notifications.js", () => ({
  sendReservationConfirmation: mockSendReservationConfirmation,
}))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const SLOT = {
  id: "ts_01",
  date: new Date("2026-03-15T00:00:00.000Z"),
  startTime: "19:30",
  durationMinutes: 90,
  maxCovers: 40,
  reservedCovers: 0,
  createdAt: new Date(),
}

const TABLES = [
  { id: "tbl_01", number: "1", capacity: 4, location: "indoor", accessible: false, active: true, createdAt: new Date() },
  { id: "tbl_02", number: "2", capacity: 4, location: "outdoor", accessible: false, active: true, createdAt: new Date() },
]

function makeCreatedReservation(overrides = {}) {
  return {
    id: "res_01",
    customerId: "cus_01",
    partySize: 4,
    status: "confirmed",
    specialRequests: [],
    confirmedAt: new Date(),
    checkedInAt: null,
    cancelledAt: null,
    timeSlotId: "ts_01",
    createdAt: new Date(),
    updatedAt: new Date(),
    timeSlot: SLOT,
    tables: [{ reservationId: "res_01", tableId: "tbl_01", table: TABLES[0] }],
    ...overrides,
  }
}

const BASE_INPUT = {
  customerId: "cus_01",
  timeSlotId: "ts_01",
  partySize: 4,
  specialRequests: [],
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockSendReservationConfirmation.mockResolvedValue(undefined)
    // Default: tables available, none reserved currently
    mockTableFindMany.mockResolvedValue(TABLES)
    mockReservationTableFindMany.mockResolvedValue([])
    // Default transaction: return created reservation
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        reservation: {
          create: vi.fn().mockResolvedValue(makeCreatedReservation()),
        },
        timeSlot: {
          update: vi.fn().mockResolvedValue(undefined),
        },
      }
      return cb(mockTx)
    })
  })

  it("throws when time slot is not found", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(null)

    await expect(createReservation(BASE_INPUT)).rejects.toThrow("Horário não encontrado")
  })

  it("throws when slot has insufficient capacity", async () => {
    mockTimeSlotFindUnique.mockResolvedValue({
      ...SLOT,
      maxCovers: 10,
      reservedCovers: 8, // only 2 available, need 4
    })

    await expect(createReservation(BASE_INPUT)).rejects.toThrow("esgotado")
  })

  it("returns confirmation DTO on success", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    const result = await createReservation(BASE_INPUT)

    expect(result.reservationId).toBe("res_01")
    expect(result.confirmed).toBe(true)
    expect(result.partySize).toBe(4)
    expect(result.confirmationMessage).toContain("Reserva confirmada")
  })

  it("publishes reservation.created NATS event", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    await createReservation(BASE_INPUT)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "reservation.created",
      expect.objectContaining({
        eventType: "reservation.created",
        customerId: "cus_01",
        metadata: expect.objectContaining({ reservationId: "res_01" }),
      }),
    )
  })

  it("calls sendReservationConfirmation with correct data", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    await createReservation(BASE_INPUT)

    expect(mockSendReservationConfirmation).toHaveBeenCalledOnce()
    const [dto] = mockSendReservationConfirmation.mock.calls[0] as [{ id: string; partySize: number }]
    expect(dto.id).toBe("res_01")
    expect(dto.partySize).toBe(4)
  })

  it("runs db changes inside a transaction", async () => {
    mockTimeSlotFindUnique.mockResolvedValue(SLOT)

    await createReservation(BASE_INPUT)

    expect(mockTransaction).toHaveBeenCalledOnce()
  })
})
