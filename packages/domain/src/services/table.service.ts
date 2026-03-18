// TableService — centralizes table and time-slot management.
//
// Handles: table CRUD, time-slot batch generation.
// Used exclusively by admin routes.

import { prisma } from "../client.js"

// ── Service ───────────────────────────────────────────────────────────────────

export function createTableService() {
  return {
    /** List all tables ordered by number. */
    async listAll() {
      return prisma.table.findMany({ orderBy: { number: "asc" } })
    },

    /** Create or update a table by number. */
    async upsert(data: {
      number: string
      capacity: number
      location: string
      accessible: boolean
      active: boolean
    }) {
      return prisma.table.upsert({
        where: { number: data.number },
        update: {
          capacity: data.capacity,
          location: data.location,
          accessible: data.accessible,
          active: data.active,
        },
        create: data,
      })
    },

    /**
     * Generate time slots for a date range.
     * Creates one slot per (date, startTime) pair, skipping duplicates.
     */
    async generateTimeSlots(input: {
      fromDate: string
      toDate: string
      startTimes: string[]
      maxCovers: number
      durationMinutes: number
    }) {
      const from = new Date(`${input.fromDate}T00:00:00.000Z`)
      const to = new Date(`${input.toDate}T00:00:00.000Z`)
      const rows: Array<{
        date: Date
        startTime: string
        maxCovers: number
        durationMinutes: number
      }> = []
      const current = new Date(from)

      while (current <= to) {
        for (const startTime of input.startTimes) {
          rows.push({
            date: new Date(current),
            startTime,
            maxCovers: input.maxCovers,
            durationMinutes: input.durationMinutes,
          })
        }
        current.setUTCDate(current.getUTCDate() + 1)
      }

      return prisma.timeSlot.createMany({ data: rows, skipDuplicates: true })
    },
  }
}

export type TableService = ReturnType<typeof createTableService>
