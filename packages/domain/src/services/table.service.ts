// TableService — centralizes table and time-slot management.
//
// Handles: table CRUD (create / partial-update / soft-deactivate / list) and
// reservation time-slot batch generation. Used exclusively by the manager-gated
// admin routes (apps/api/src/routes/admin/tables.ts). No LLM/agent caller.
//
// OPS-018 (table CRUD) + OPS-019 (time-slot generation).

import { prisma } from "../client.js"
import { TableLocation as PrismaTableLocation } from "../generated/prisma-client/client.js"

// ── Typed errors ────────────────────────────────────────────────────────────
// Surfaced to the route layer, which maps them to pt-BR HTTP responses.

/** A table with the requested `number` already exists (unique-constraint). */
export class DuplicateTableNumberError extends Error {
  constructor(public readonly number: string) {
    super(`Table number already exists: ${number}`)
    this.name = "DuplicateTableNumberError"
  }
}

/** No table exists for the requested id. */
export class TableNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Table not found: ${id}`)
    this.name = "TableNotFoundError"
  }
}

/**
 * Deactivation was blocked because the table still holds active reservations
 * with a current-or-future slot — soft-deactivating it would orphan those
 * bookings. The operator must cancel or reallocate them first.
 */
export class TableHasFutureReservationsError extends Error {
  constructor(
    public readonly id: string,
    public readonly count: number,
  ) {
    super(`Table ${id} has ${count} active future reservation(s)`)
    this.name = "TableHasFutureReservationsError"
  }
}

/** Reservation statuses that still hold a table (vs. cancelled/completed/no_show). */
const ACTIVE_RESERVATION_STATUSES = ["pending", "confirmed", "seated"] as const

/** Read the Prisma known-error code (`P2002`, `P2025`, …) if present. */
function prismaErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

// ── Time-slot generation helpers ────────────────────────────────────────────

/** RESTAURANT_*_HOUR env fallbacks — mirrors packages/tools schedule-helpers. */
const DEFAULT_HOURS = {
  lunchStart: 11,
  lunchEnd: 15,
  dinnerStart: 18,
  dinnerEnd: 23,
} as const

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function minutesToHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/**
 * Derive the reservation slot start-times from the configured restaurant hours
 * (RESTAURANT_LUNCH/DINNER_START/END_HOUR) stepping by `intervalMinutes`.
 *
 * Pure + deterministic (env-only, no wall-clock). Windows are half-open
 * `[start, end)`, so a slot never starts exactly at closing time. Returns a
 * de-duplicated, ascending list of `HH:MM` strings — the shape the booking path
 * (`reservation.service` checkAvailability) consumes.
 */
export function slotStartTimesFromHours(intervalMinutes: number): string[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new RangeError(`intervalMinutes must be a positive integer, got ${intervalMinutes}`)
  }
  const windows: Array<readonly [number, number]> = [
    [envInt("RESTAURANT_LUNCH_START_HOUR", DEFAULT_HOURS.lunchStart), envInt("RESTAURANT_LUNCH_END_HOUR", DEFAULT_HOURS.lunchEnd)],
    [envInt("RESTAURANT_DINNER_START_HOUR", DEFAULT_HOURS.dinnerStart), envInt("RESTAURANT_DINNER_END_HOUR", DEFAULT_HOURS.dinnerEnd)],
  ]
  const times = new Set<string>()
  for (const [startHour, endHour] of windows) {
    for (let m = startHour * 60; m < endHour * 60; m += intervalMinutes) {
      times.add(minutesToHHMM(m))
    }
  }
  return [...times].sort((a, b) => a.localeCompare(b))
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^\d{2}:\d{2}$/

/** UTC-anchored `Date` (midnight) for a `YYYY-MM-DD` string. */
function isoToUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

/** `YYYY-MM-DD` for a `Date`, using its UTC calendar day. */
function utcDateToIso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Add `days` UTC calendar days to a `YYYY-MM-DD` string. */
function addDaysIso(iso: string, days: number): string {
  const d = isoToUtcDate(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return utcDateToIso(d)
}

// ── Service ───────────────────────────────────────────────────────────────────

export interface TableServiceDeps {
  /** Injectable clock (default `() => new Date()`). Used for now-relative
   *  slot-generation defaults so the generator is deterministic under test. */
  now?: () => Date
}

export function createTableService(deps: TableServiceDeps = {}) {
  const now = deps.now ?? (() => new Date())

  return {
    /** List all tables ordered by number. */
    async listAll() {
      return prisma.table.findMany({ orderBy: { number: "asc" } })
    },

    /**
     * Create a table. Rejects a duplicate `number` with
     * {@link DuplicateTableNumberError} (unique-constraint, not a silent
     * overwrite).
     */
    async create(data: {
      number: string
      capacity: number
      location: string
      accessible: boolean
      active: boolean
    }) {
      try {
        return await prisma.table.create({
          data: { ...data, location: data.location as PrismaTableLocation },
        })
      } catch (err) {
        if (prismaErrorCode(err) === "P2002") {
          throw new DuplicateTableNumberError(data.number)
        }
        throw err
      }
    },

    /**
     * Partially update a table by id. Only the provided fields change.
     * Throws {@link TableNotFoundError} when the id is unknown and
     * {@link DuplicateTableNumberError} when a new `number` collides.
     *
     * Soft-deactivation is `update(id, { active: false })`. Deactivating a
     * table that still holds active reservations (pending/confirmed/seated)
     * with a current-or-future slot is blocked with
     * {@link TableHasFutureReservationsError} so bookings are never silently
     * orphaned — the operator cancels or reallocates them first. (Reservations
     * link to specific tables via the `ReservationTable` join.)
     */
    async update(
      id: string,
      patch: {
        number?: string
        capacity?: number
        location?: string
        accessible?: boolean
        active?: boolean
      },
    ) {
      if (patch.active === false) {
        // Threshold = start of today (UTC) so slots earlier *today* still count.
        const todayMidnightUtc = isoToUtcDate(utcDateToIso(now()))
        const blocking = await prisma.reservationTable.count({
          where: {
            tableId: id,
            reservation: {
              status: { in: [...ACTIVE_RESERVATION_STATUSES] },
              timeSlot: { date: { gte: todayMidnightUtc } },
            },
          },
        })
        if (blocking > 0) {
          throw new TableHasFutureReservationsError(id, blocking)
        }
      }
      try {
        return await prisma.table.update({
          where: { id },
          data: {
            ...(patch.number !== undefined ? { number: patch.number } : {}),
            ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
            ...(patch.location !== undefined
              ? { location: patch.location as PrismaTableLocation }
              : {}),
            ...(patch.accessible !== undefined ? { accessible: patch.accessible } : {}),
            ...(patch.active !== undefined ? { active: patch.active } : {}),
          },
        })
      } catch (err) {
        const code = prismaErrorCode(err)
        if (code === "P2025") throw new TableNotFoundError(id)
        if (code === "P2002") throw new DuplicateTableNumberError(patch.number ?? "")
        throw err
      }
    },

    /**
     * Generate reservation time slots for a date range.
     *
     * Idempotent: one slot per `(date, startTime)` pair, existing pairs skipped
     * via `createMany({ skipDuplicates })` backed by `@@unique([date, startTime])`
     * — re-running an overlapping range never duplicates.
     *
     * Start times come from either an explicit `startTimes` list OR, when
     * omitted, {@link slotStartTimesFromHours} over the configured restaurant
     * hours stepping by `intervalMinutes`. The date range defaults to
     * `[today, today + RESERVATION_SLOT_HORIZON_DAYS]` (UTC), resolved from the
     * injected clock so tests are deterministic.
     */
    async generateTimeSlots(input: {
      fromDate?: string
      toDate?: string
      startTimes?: string[]
      intervalMinutes?: number
      maxCovers: number
      durationMinutes?: number
    }): Promise<{ count: number }> {
      const fromDate = input.fromDate ?? utcDateToIso(now())
      const horizonDays = envInt("RESERVATION_SLOT_HORIZON_DAYS", 14)
      const toDate = input.toDate ?? addDaysIso(fromDate, horizonDays)

      if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) {
        throw new RangeError(`fromDate/toDate must be YYYY-MM-DD, got ${fromDate}..${toDate}`)
      }
      if (fromDate > toDate) {
        throw new RangeError(`fromDate ${fromDate} must not be after toDate ${toDate}`)
      }

      const intervalMinutes =
        input.intervalMinutes ?? envInt("RESERVATION_SLOT_INTERVAL_MINUTES", 30)

      let startTimes: string[]
      if (input.startTimes && input.startTimes.length > 0) {
        for (const t of input.startTimes) {
          if (!HHMM.test(t)) {
            throw new RangeError(`startTime must be HH:MM, got "${t}"`)
          }
        }
        startTimes = [...new Set(input.startTimes)].sort((a, b) => a.localeCompare(b))
      } else {
        startTimes = slotStartTimesFromHours(intervalMinutes)
      }

      if (startTimes.length === 0) {
        return { count: 0 }
      }

      const durationMinutes = input.durationMinutes ?? 90
      const rows: Array<{
        date: Date
        startTime: string
        maxCovers: number
        durationMinutes: number
      }> = []

      let currentIso = fromDate
      while (currentIso <= toDate) {
        const date = isoToUtcDate(currentIso)
        for (const startTime of startTimes) {
          rows.push({ date, startTime, maxCovers: input.maxCovers, durationMinutes })
        }
        currentIso = addDaysIso(currentIso, 1)
      }

      const result = await prisma.timeSlot.createMany({ data: rows, skipDuplicates: true })
      return { count: result.count }
    },
  }
}

export type TableService = ReturnType<typeof createTableService>
