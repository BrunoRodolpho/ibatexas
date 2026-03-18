// Shared pure utilities for reservation tools.
// Business logic (Prisma transactions, table assignment) lives in @ibatexas/domain ReservationService.

import type { TableLocation } from "@ibatexas/types"

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

export function locationLabel(location: string | TableLocation | null): string {
  return location ? (LOCATION_LABELS[location] ?? location) : "salão"
}
