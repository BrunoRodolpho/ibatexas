// Shared utilities for reservation tools.

import { prisma } from "@ibatexas/domain"
import { ReservationStatus, TableLocation, type ReservationDTO, type SpecialRequest } from "@ibatexas/types"

type TimeSlotRow = { id: string; date: Date; startTime: string; durationMinutes: number; maxCovers: number; reservedCovers: number; createdAt: Date }
type TableRow = { id: string; number: string; capacity: number; location: TableLocation; active: boolean; createdAt: Date }
type ReservationTableRow = { reservationId: string; tableId: string; table: TableRow }
export type ReservationWithRelations = {
  id: string
  customerId: string
  partySize: number
  status: ReservationStatus
  specialRequests: SpecialRequest[] | null
  timeSlot: TimeSlotRow
  tables: ReservationTableRow[]
  confirmedAt: Date | null
  checkedInAt: Date | null
  cancelledAt: Date | null
  noShowAt?: Date | null
  createdAt: Date
  updatedAt: Date
  timeSlotId: string
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

export function reservationToDTO(r: ReservationWithRelations): ReservationDTO {
  // Derive table location from assigned tables (use the most common, or first)
  const locations = r.tables.map((rt) => rt.table.location)
  const tableLocation = locations.length > 0 ? (locations[0] ?? null) : null

  return {
    id: r.id,
    customerId: r.customerId,
    partySize: r.partySize,
    status: r.status,
    specialRequests: r.specialRequests ?? [],
    timeSlot: {
      id: r.timeSlot.id,
      date: r.timeSlot.date.toISOString().split("T")[0] ?? "",
      startTime: r.timeSlot.startTime,
      durationMinutes: r.timeSlot.durationMinutes,
    },
    tableLocation,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

// ─── Table assignment ─────────────────────────────────────────────────────────

/**
 * Assign tables to cover `partySize` for a given time slot.
 * Strategy: find active tables not already fully booked in this slot.
 * Prefers fewer tables (greedy, largest-first).
 * Returns the selected table IDs, or throws if no valid combination exists.
 */
export async function assignTables(
  timeSlotId: string,
  partySize: number,
): Promise<string[]> {
  // IDs already reserved in this slot
  const alreadyReserved = await prisma.reservationTable.findMany({
    where: {
      reservation: {
        timeSlotId,
        status: { notIn: ["cancelled", "no_show"] },
      },
    },
    select: { tableId: true },
  })

  const reservedTableIds = new Set(alreadyReserved.map((rt) => rt.tableId))

  const available = await prisma.table.findMany({
    where: { active: true, id: { notIn: Array.from(reservedTableIds) } },
    orderBy: { capacity: "desc" },
  })

  // Greedy: pick fewest tables that cover partySize
  const selected: string[] = []
  let covered = 0

  for (const table of available) {
    if (covered >= partySize) break
    selected.push(table.id)
    covered += table.capacity
  }

  if (covered < partySize) {
    throw new Error("Não há mesas disponíveis para este número de pessoas neste horário.")
  }

  return selected
}

/**
 * Release all tables and reduce reservedCovers for a reservation.
 * Used by cancel and no-show checker.
 */
export async function releaseReservation(reservationId: string): Promise<void> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { timeSlot: true },
  })
  if (!reservation) return

  await prisma.$transaction([
    prisma.reservationTable.deleteMany({ where: { reservationId } }),
    prisma.timeSlot.update({
      where: { id: reservation.timeSlotId },
      data: { reservedCovers: { decrement: reservation.partySize } },
    }),
  ])
}

// ─── DateTime helpers ─────────────────────────────────────────────────────────

/** Build an ISO 8601 datetime string from a date and startTime ('19:30'). */
export function buildDateTime(date: Date, startTime: string): string {
  const dateStr = date.toISOString().split("T")[0] ?? ""
  return `${dateStr}T${startTime}:00`
}

/** Format a date as Brazilian locale string for WhatsApp/confirmation messages. */
export function formatDateBR(date: Date): string {
  return date.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  })
}

const LOCATION_LABELS: Record<string, string> = {
  indoor: "salão interno",
  outdoor: "área externa",
  bar: "balcão do bar",
  terrace: "terraço",
}

export function locationLabel(location: string | null): string {
  return location ? (LOCATION_LABELS[location] ?? location) : "salão"
}
