// ReservationService — single source of reservation business logic.
//
// Tools, API routes, and background jobs all call these methods.
// Side effects (NATS events, WhatsApp) stay in the calling layer.

import { prisma } from "../client.js"
import { assertOwnership, assertMutable } from "./shared.js"
import { Prisma, ReservationStatus as PrismaReservationStatus } from "../generated/prisma-client/index.js"
import type { PrismaClient } from "../generated/prisma-client/index.js"
import type {
  ReservationDTO,
  AvailableSlot,
  SpecialRequest,
  ReservationStatus,
  TableLocation,
} from "@ibatexas/types"

// AUDIT-FIX: DL-F01 — Transaction client type for interactive transactions
type TxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">

// ── Internal types ────────────────────────────────────────────────────────────

type TimeSlotRow = {
  id: string; date: Date; startTime: string; durationMinutes: number;
  maxCovers: number; reservedCovers: number; createdAt: Date;
}

type TableRow = {
  id: string; number: string; capacity: number; location: string;
  active: boolean; createdAt: Date;
}

type ReservationWithRelations = {
  id: string; customerId: string; partySize: number; status: string;
  specialRequests: SpecialRequest[] | null; timeSlot: TimeSlotRow;
  tables: Array<{ reservationId: string; tableId: string; table: TableRow }>;
  confirmedAt: Date | null; checkedInAt: Date | null; cancelledAt: Date | null;
  noShowAt?: Date | null; createdAt: Date; updatedAt: Date; timeSlotId: string;
}

// ── DTO mapper ────────────────────────────────────────────────────────────────

function toDTO(r: ReservationWithRelations): ReservationDTO {
  const locations = r.tables.map((rt) => rt.table.location)
  const tableLocation = (locations.length > 0 ? (locations[0] ?? null) : null) as TableLocation | null

  return {
    id: r.id,
    customerId: r.customerId,
    partySize: r.partySize,
    status: r.status as ReservationStatus,
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

// ── Table assignment ──────────────────────────────────────────────────────────

/**
 * Assign tables to cover partySize for a slot.
 * Greedy largest-first strategy: fewest tables that cover the party.
 * AUDIT-FIX: DL-F01/DL-F11 — accepts optional tx client so it can run inside a transaction
 */
async function assignTables(timeSlotId: string, partySize: number, db: TxClient | typeof prisma = prisma): Promise<string[]> {
  const alreadyReserved = await db.reservationTable.findMany({
    where: {
      reservation: { timeSlotId, status: { notIn: ["cancelled", "no_show"] } },
    },
    select: { tableId: true },
  })

  const reservedTableIds = new Set(alreadyReserved.map((rt) => rt.tableId))

  const available = await db.table.findMany({
    where: { active: true, id: { notIn: Array.from(reservedTableIds) } },
    orderBy: { capacity: "desc" },
  })

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

// ── Service factory ───────────────────────────────────────────────────────────

export function createReservationService() {
  return {
    // ── Queries ─────────────────────────────────────────────────────────

    // AUDIT-FIX: DL-F05 — Replaced N+1 per-slot queries with two bulk queries.
    // Previously: 1 + (slots * 2) queries. Now: 3 queries total (slots + reservationTables + allTables).
    async checkAvailability(
      date: string,
      partySize: number,
      preferredTime?: string,
    ): Promise<AvailableSlot[]> {
      const dateObj = new Date(`${date}T00:00:00.000Z`)

      const slots = await prisma.timeSlot.findMany({
        where: { date: dateObj },
        orderBy: { startTime: "asc" },
      })

      if (slots.length === 0) return []

      const slotIds = slots.map((s) => s.id)

      // Bulk-fetch all reserved table assignments for the date's slots
      const allReservedTables = await prisma.reservationTable.findMany({
        where: {
          reservation: { timeSlotId: { in: slotIds }, status: { notIn: ["cancelled", "no_show"] } },
        },
        select: { tableId: true, reservation: { select: { timeSlotId: true } } },
      })

      // Build a map: slotId → Set of reserved tableIds
      const reservedBySlot = new Map<string, Set<string>>()
      for (const rt of allReservedTables) {
        const slotId = rt.reservation.timeSlotId
        if (!reservedBySlot.has(slotId)) reservedBySlot.set(slotId, new Set())
        reservedBySlot.get(slotId)!.add(rt.tableId)
      }

      // Bulk-fetch all active tables once
      const allActiveTables = await prisma.table.findMany({
        where: { active: true },
        select: { id: true, location: true },
      })

      const result: AvailableSlot[] = []

      for (const slot of slots) {
        const availableCovers = slot.maxCovers - slot.reservedCovers
        if (availableCovers < partySize) continue
        if (preferredTime && slot.startTime !== preferredTime) continue

        const reservedIds = reservedBySlot.get(slot.id) ?? new Set<string>()
        const freeTables = allActiveTables.filter((t) => !reservedIds.has(t.id))
        const uniqueLocations = [...new Set(freeTables.map((t) => t.location as TableLocation))]

        result.push({
          timeSlotId: slot.id,
          date,
          startTime: slot.startTime,
          durationMinutes: slot.durationMinutes,
          availableCovers,
          tableLocations: uniqueLocations,
        })
      }

      return result
    },

    async getById(id: string, customerId?: string): Promise<ReservationDTO> {
      const reservation = await prisma.reservation.findUnique({
        where: { id },
        include: { timeSlot: true, tables: { include: { table: true } } },
      })

      if (!reservation) throw new Error("Reserva não encontrada.")
      if (customerId) assertOwnership(reservation.customerId, customerId, "esta reserva")

      return toDTO(reservation as unknown as ReservationWithRelations)
    },

    async listByCustomer(
      customerId: string,
      options?: { status?: string; limit?: number },
    ): Promise<{ reservations: ReservationDTO[]; total: number }> {
      const where = {
        customerId,
        ...(options?.status ? { status: options.status as PrismaReservationStatus } : {}),
      }

      const [reservations, total] = await Promise.all([
        prisma.reservation.findMany({
          where,
          include: { timeSlot: true, tables: { include: { table: true } } },
          orderBy: [{ timeSlot: { date: "desc" } }, { timeSlot: { startTime: "desc" } }],
          take: options?.limit ?? 10,
        }),
        prisma.reservation.count({ where }),
      ])

      return {
        reservations: (reservations as unknown as ReservationWithRelations[]).map(toDTO),
        total,
      }
    },

    async listAll(
      filters: { date?: string; status?: string },
      pagination: { limit: number; offset: number },
    ): Promise<{ reservations: ReservationDTO[]; total: number }> {
      const where: Record<string, unknown> = {}
      if (filters.status) where.status = filters.status
      if (filters.date) where.timeSlot = { date: new Date(`${filters.date}T00:00:00.000Z`) }

      const [reservations, total] = await Promise.all([
        prisma.reservation.findMany({
          where,
          include: { timeSlot: true, tables: { include: { table: true } } },
          orderBy: [{ timeSlot: { date: "asc" } }, { timeSlot: { startTime: "asc" } }],
          take: pagination.limit,
          skip: pagination.offset,
        }),
        prisma.reservation.count({ where }),
      ])

      return {
        reservations: (reservations as unknown as ReservationWithRelations[]).map(toDTO),
        total,
      }
    },

    // ── Commands ────────────────────────────────────────────────────────

    // AUDIT-FIX: DL-F01 — Restructured create() so availability check, assignTables,
    // reservation creation, and reservedCovers increment ALL happen inside a single
    // Prisma interactive transaction with SELECT ... FOR UPDATE row-level lock.
    // AUDIT-FIX: DL-F11 — assignTables() now runs inside the transaction.
    async create(input: {
      customerId: string
      timeSlotId: string
      partySize: number
      specialRequests?: SpecialRequest[]
    }): Promise<{ reservation: ReservationDTO; tableLocation: TableLocation | null }> {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Lock the time slot row to prevent concurrent reads
        const locked = await tx.$queryRaw<TimeSlotRow[]>(
          Prisma.sql`SELECT * FROM ibx_domain.time_slots WHERE id = ${input.timeSlotId} FOR UPDATE`
        )
        const slot = locked[0]
        if (!slot) throw new Error("Horário não encontrado. Verifique o ID do horário.")

        // 2. Check availability under the lock
        const availableCovers = slot.maxCovers - slot.reservedCovers
        if (availableCovers < input.partySize) {
          throw new Error(
            `Este horário está esgotado para ${input.partySize} pessoa(s). Tente outro horário ou entre na lista de espera.`,
          )
        }

        // 3. Assign tables inside the transaction
        const tableIds = await assignTables(input.timeSlotId, input.partySize, tx)

        // 4. Create the reservation with assigned tables
        const r = await tx.reservation.create({
          data: {
            customerId: input.customerId,
            partySize: input.partySize,
            status: "confirmed",
            specialRequests: input.specialRequests ?? [],
            confirmedAt: new Date(),
            timeSlotId: input.timeSlotId,
            tables: { create: tableIds.map((tableId) => ({ tableId })) },
          },
          include: { timeSlot: true, tables: { include: { table: true } } },
        })

        // 5. Increment reservedCovers
        await tx.timeSlot.update({
          where: { id: input.timeSlotId },
          data: { reservedCovers: { increment: input.partySize } },
        })

        const tableLocation = (r.tables[0]?.table?.location as TableLocation) ?? null
        return { reservation: r, tableLocation }
      })

      return {
        reservation: toDTO(result.reservation as unknown as ReservationWithRelations),
        tableLocation: result.tableLocation,
      }
    },

    async modify(
      id: string,
      customerId: string,
      changes: {
        newTimeSlotId?: string
        newPartySize?: number
        specialRequests?: SpecialRequest[]
      },
    ): Promise<ReservationDTO> {
      const existing = await prisma.reservation.findUnique({
        where: { id },
        include: { timeSlot: true, tables: { include: { table: true } } },
      })

      if (!existing) throw new Error("Reserva não encontrada.")
      assertOwnership(existing.customerId, customerId, "esta reserva")
      assertMutable(existing.status, "modificar")

      const newTimeSlotId = changes.newTimeSlotId ?? existing.timeSlotId
      const newPartySize = changes.newPartySize ?? existing.partySize
      const isChangingSlot = newTimeSlotId !== existing.timeSlotId

      if (isChangingSlot) {
        const newSlot = await prisma.timeSlot.findUnique({ where: { id: newTimeSlotId } })
        if (!newSlot) throw new Error("Novo horário não encontrado.")
        const available = newSlot.maxCovers - newSlot.reservedCovers
        if (available < newPartySize) {
          throw new Error(`O horário solicitado não tem vagas para ${newPartySize} pessoa(s).`)
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.timeSlot.update({
          where: { id: existing.timeSlotId },
          data: { reservedCovers: { decrement: existing.partySize } },
        })

        await tx.reservationTable.deleteMany({ where: { reservationId: existing.id } })

        const newTableIds = await assignTables(newTimeSlotId, newPartySize)

        await tx.timeSlot.update({
          where: { id: newTimeSlotId },
          data: { reservedCovers: { increment: newPartySize } },
        })

        return tx.reservation.update({
          where: { id: existing.id },
          data: {
            timeSlotId: newTimeSlotId,
            partySize: newPartySize,
            specialRequests: changes.specialRequests ?? existing.specialRequests ?? [],
            tables: { create: newTableIds.map((tableId) => ({ tableId })) },
          },
          include: { timeSlot: true, tables: { include: { table: true } } },
        })
      })

      return toDTO(updated as unknown as ReservationWithRelations)
    },

    async cancel(id: string, customerId: string): Promise<{ timeSlotId: string; partySize: number }> {
      const reservation = await prisma.reservation.findUnique({
        where: { id },
        include: { timeSlot: true },
      })

      if (!reservation) throw new Error("Reserva não encontrada.")
      assertOwnership(reservation.customerId, customerId, "esta reserva")
      assertMutable(reservation.status, "cancelar")

      await prisma.$transaction([
        prisma.reservation.update({
          where: { id },
          data: { status: "cancelled", cancelledAt: new Date() },
        }),
        prisma.reservationTable.deleteMany({ where: { reservationId: id } }),
        prisma.timeSlot.update({
          where: { id: reservation.timeSlotId },
          data: { reservedCovers: { decrement: reservation.partySize } },
        }),
      ])

      return { timeSlotId: reservation.timeSlotId, partySize: reservation.partySize }
    },

    async transition(
      id: string,
      newStatus: "seated" | "completed" | "no_show",
    ): Promise<void> {
      const data: Record<string, unknown> = { status: newStatus }
      if (newStatus === "seated") data.checkedInAt = new Date()

      if (newStatus === "no_show") {
        const reservation = await prisma.reservation.findUnique({
          where: { id },
          include: { timeSlot: true },
        })
        if (!reservation) return

        await prisma.$transaction([
          prisma.reservation.update({ where: { id }, data: { status: "no_show" } }),
          prisma.timeSlot.update({
            where: { id: reservation.timeSlotId },
            data: { reservedCovers: { decrement: reservation.partySize } },
          }),
          prisma.reservationTable.deleteMany({ where: { reservationId: id } }),
        ])
        return
      }

      await prisma.reservation.update({ where: { id }, data })
    },

    // ── Waitlist ────────────────────────────────────────────────────────

    async promoteWaitlist(timeSlotId: string): Promise<{
      promoted: { id: string; customerId: string; partySize: number; date: string; startTime: string } | null
    }> {
      const nextInLine = await prisma.waitlist.findFirst({
        where: { timeSlotId, notifiedAt: null },
        orderBy: { createdAt: "asc" },
      })

      if (!nextInLine) return { promoted: null }

      const waitlistOfferMinutes = Number.parseInt(process.env.WAITLIST_OFFER_MINUTES || "30", 10)
      const expiresAt = new Date(Date.now() + waitlistOfferMinutes * 60 * 1000)

      await prisma.waitlist.update({
        where: { id: nextInLine.id },
        data: { notifiedAt: new Date(), expiresAt },
      })

      const slot = await prisma.timeSlot.findUnique({ where: { id: timeSlotId } })

      return {
        promoted: {
          id: nextInLine.id,
          customerId: nextInLine.customerId,
          partySize: nextInLine.partySize,
          date: slot?.date.toISOString().split("T")[0] ?? "",
          startTime: slot?.startTime ?? "",
        },
      }
    },

    async joinWaitlist(input: {
      customerId: string
      timeSlotId: string
      partySize: number
    }): Promise<{ waitlistId: string; position: number }> {
      const slot = await prisma.timeSlot.findUnique({ where: { id: input.timeSlotId } })
      if (!slot) throw new Error("Horário não encontrado.")

      const alreadyWaiting = await prisma.waitlist.findFirst({
        where: { customerId: input.customerId, timeSlotId: input.timeSlotId, notifiedAt: null },
      })

      if (alreadyWaiting) {
        const position = await prisma.waitlist.count({
          where: { timeSlotId: input.timeSlotId, createdAt: { lte: alreadyWaiting.createdAt }, notifiedAt: null },
        })
        return { waitlistId: alreadyWaiting.id, position }
      }

      const waitlistExpiryHours = Number.parseInt(process.env.WAITLIST_EXPIRY_HOURS || "24", 10)
      const expiresAt = new Date(Date.now() + waitlistExpiryHours * 60 * 60 * 1000)

      const entry = await prisma.waitlist.create({
        data: { customerId: input.customerId, timeSlotId: input.timeSlotId, partySize: input.partySize, expiresAt },
      })

      const position = await prisma.waitlist.count({
        where: { timeSlotId: input.timeSlotId, createdAt: { lte: entry.createdAt }, notifiedAt: null },
      })

      return { waitlistId: entry.id, position }
    },

    // ── Queries (admin / jobs) ─────────────────────────────────────────

    /**
     * Count active reservations (pending/confirmed/seated with future slots).
     * Used by admin dashboard.
     */
    async countActive(): Promise<number> {
      return prisma.reservation.count({
        where: {
          status: { in: ["pending", "confirmed", "seated"] },
          timeSlot: { date: { gte: new Date() } },
        },
      })
    },

    /**
     * Find confirmed reservations for a specific date.
     * Used by no-show checker job.
     */
    async findConfirmedForDate(date: Date) {
      return prisma.reservation.findMany({
        where: { status: "confirmed", timeSlot: { date } },
        include: { timeSlot: true },
      })
    },
  }
}

export type ReservationService = ReturnType<typeof createReservationService>
