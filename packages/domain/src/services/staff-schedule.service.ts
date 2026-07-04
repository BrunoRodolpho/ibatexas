// StaffScheduleService — the NEW-016 "escala" core: assign shifts to staff and
// list the schedule over a date range.
//
// Plain CRUD (mirrors table.service.ts / delivery-zone.service.ts) — staff
// scheduling is admin-ops, NOT a customer money/safety path, so it does NOT go
// through the adjudicate kernel; the manager-gate lives at the route
// (requireManagerRole). Scope is deliberately narrow: assign + list + delete.
// Clock-in and labor-cost analytics are OUT of scope (deferred).
//
// listShifts resolves its [from, to) window to LOCAL-day boundaries in the
// restaurant's business timezone (the SAME idiom day-close / order-analytics use
// via ./__shared__/day-window.js) so a schedule for "today" means the restaurant's
// business day, never the server's local day.

import { prisma } from "../client.js"
import { assertYmd, localDayStartUtc, resolveTimezone } from "./__shared__/day-window.js"

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for assigning a new shift. `startsAt`/`endsAt` are absolute instants. */
export interface CreateShiftInput {
  readonly staffId: string
  readonly startsAt: Date
  readonly endsAt: Date
  /** Optional role worked this shift (free-form; e.g. the staff's role). */
  readonly role?: string | null
  readonly note?: string | null
}

/** Params for listing the schedule over a LOCAL-date range. */
export interface ListShiftsParams {
  /** Range start, YYYY-MM-DD — INCLUSIVE (local day). */
  readonly from: string
  /** Range end, YYYY-MM-DD — EXCLUSIVE (local day). */
  readonly to: string
  /** Optional: restrict to one staff member. */
  readonly staffId?: string
  /** IANA zone; defaults to RESTAURANT_TIMEZONE then America/Sao_Paulo. */
  readonly timezone?: string
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createStaffScheduleService() {
  return {
    /** Assign a shift to a staff member. */
    async createShift(input: CreateShiftInput) {
      return prisma.staffShift.create({
        data: {
          staffId: input.staffId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          role: input.role ?? null,
          note: input.note ?? null,
        },
      })
    },

    /**
     * List the schedule over the [from, to) local-date window, resolved to the
     * business-timezone day boundaries. Shifts are matched on `startsAt` in the
     * window; optionally filtered to one staff member. Ordered chronologically,
     * then by staffId for a stable board.
     */
    async listShifts(params: ListShiftsParams) {
      assertYmd("listShifts: from", params.from)
      assertYmd("listShifts: to", params.to)
      const timezone = resolveTimezone(params)
      const windowStart = localDayStartUtc(params.from, timezone)
      const windowEnd = localDayStartUtc(params.to, timezone)

      return prisma.staffShift.findMany({
        where: {
          startsAt: { gte: windowStart, lt: windowEnd },
          ...(params.staffId ? { staffId: params.staffId } : {}),
        },
        orderBy: [{ startsAt: "asc" }, { staffId: "asc" }],
      })
    },

    /**
     * Delete a shift by id. Returns the deleted row, or `null` when no row with
     * that id exists (idempotent — avoids Prisma's P2025 throw and lets the route
     * 404 without a second-click race). Uses deleteMany so a missing id is a count
     * of 0 rather than an exception.
     */
    async deleteShift(id: string) {
      const existing = await prisma.staffShift.findUnique({ where: { id } })
      if (!existing) return null
      await prisma.staffShift.deleteMany({ where: { id } })
      return existing
    },

    /**
     * NEW-034 — clock IN a shift: stamp `actualStart` to `at` (defaults to now).
     * Returns the updated row, or `null` when no shift with that id exists
     * (row-or-null, mirrors deleteShift — findUnique existence check + updateMany,
     * so a missing id is a no-op rather than a P2025 throw; the route 404s on null).
     * Idempotent by design: a re-clock-in simply re-stamps the newer `at`.
     */
    async clockIn(shiftId: string, at?: Date) {
      const existing = await prisma.staffShift.findUnique({ where: { id: shiftId } })
      if (!existing) return null
      const actualStart = at ?? new Date()
      await prisma.staffShift.updateMany({ where: { id: shiftId }, data: { actualStart } })
      return { ...existing, actualStart }
    },

    /**
     * NEW-034 — clock OUT a shift: stamp `actualEnd` to `at` (defaults to now).
     * Returns the updated row, or `null` when no shift with that id exists (same
     * row-or-null contract as clockIn / deleteShift). Labor cost counts ACTUAL
     * hours for this shift only once BOTH `actualStart` and `actualEnd` are set.
     */
    async clockOut(shiftId: string, at?: Date) {
      const existing = await prisma.staffShift.findUnique({ where: { id: shiftId } })
      if (!existing) return null
      const actualEnd = at ?? new Date()
      await prisma.staffShift.updateMany({ where: { id: shiftId }, data: { actualEnd } })
      return { ...existing, actualEnd }
    },
  }
}

export type StaffScheduleService = ReturnType<typeof createStaffScheduleService>
