// Shared pure utilities for reservation tools.
// Business logic (Prisma transactions, table assignment) lives in @ibatexas/domain ReservationService.

import type { TableLocation } from "@ibatexas/types"

// ─── DateTime helpers ─────────────────────────────────────────────────────────

/** Build an ISO 8601 datetime string from a date and startTime ('19:30'). */
export function buildDateTime(date: Date, startTime: string): string {
  const dateStr = date.toISOString().split("T")[0] ?? ""
  return `${dateStr}T${startTime}:00`
}

/**
 * Format a reservation date as a pt-BR label for WhatsApp/confirmation messages.
 *
 * The input is a CALENDAR DATE (date-only), not a wall-clock instant: reservation
 * dates are stored as `@db.Date` (UTC midnight) and extracted elsewhere via the UTC
 * date part (see {@link buildDateTime} and the slot `startAt` build). Formatting such
 * a value in a wall-clock zone WEST of UTC (e.g. America/Sao_Paulo, UTC-3) rolls a
 * UTC-midnight date back to the previous day — the FE-D11 off-by-one ("15 de julho"
 * for a 2026-07-16 booking). We therefore format the calendar date in UTC so the
 * label always names the SAME day `buildDateTime` records (and that noon-UTC callers
 * already see). Locale (pt-BR) governs language; UTC governs which calendar day.
 */
export function formatDateBR(date: Date): string {
  return date.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

const LOCATION_LABELS: Record<string, string> = {
  indoor: "salão interno",
  outdoor: "área externa",
  bar: "balcão do bar",
  terrace: "terraço",
}

export function locationLabel(location: string | TableLocation | null): string {
  return location ? (LOCATION_LABELS[location] ?? location) : "salão"
}
