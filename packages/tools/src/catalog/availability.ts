// Shared availability window checker.
// Used by search (annotate products) and cart (guard against ordering unavailable items).

import type { RestaurantSchedule } from "@ibatexas/domain"
import { AvailabilityWindow } from "@ibatexas/types"
import { isAvailableFromSchedule, getMealPeriodFromSchedule } from "../schedule/schedule-helpers.js"

/**
 * Check if a product's availability window is currently open.
 * Uses DB schedule when provided, falls back to env vars.
 */
export function isAvailableNow(availabilityWindow: string, schedule?: RestaurantSchedule): boolean {
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"

  if (schedule) {
    return isAvailableFromSchedule(availabilityWindow, schedule, tz)
  }

  // Fallback: env vars
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).formatToParts(new Date())
  const hourPart = parts.find((p) => p.type === "hour")
  let hour = Number.parseInt(hourPart?.value ?? "0", 10)
  if (hour === 24) hour = 0

  const lunchStart = Number.parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = Number.parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)

  switch (availabilityWindow) {
    case AvailabilityWindow.ALMOCO:
      return hour >= lunchStart && hour < lunchEnd
    case AvailabilityWindow.JANTAR:
      return hour >= dinnerStart && hour < dinnerEnd
    case AvailabilityWindow.CONGELADOS:
    case AvailabilityWindow.SEMPRE:
      return true
    default:
      return true
  }
}

/**
 * Get a human-readable description of an availability window.
 * Uses schedule hours when available.
 */
export function describeAvailabilityWindow(availabilityWindow: string, schedule?: RestaurantSchedule): string {
  if (schedule) {
    // Extract hours from today's schedule
    const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"
    const dayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date())
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const dow = dayMap[dayStr] ?? new Date().getDay()
    const day = schedule.days.find((d) => d.dayOfWeek === dow)

    if (day) {
      const lunchStr = day.lunchStart && day.lunchEnd
        ? `${Number.parseInt(day.lunchStart, 10)}h-${Number.parseInt(day.lunchEnd, 10)}h` : null
      const dinnerStr = day.dinnerStart && day.dinnerEnd
        ? `${Number.parseInt(day.dinnerStart, 10)}h-${Number.parseInt(day.dinnerEnd, 10)}h` : null

      switch (availabilityWindow) {
        case AvailabilityWindow.ALMOCO:
          return lunchStr ? `almoço (${lunchStr})` : "almoço"
        case AvailabilityWindow.JANTAR:
          return dinnerStr ? `jantar (${dinnerStr})` : "jantar"
        case AvailabilityWindow.CONGELADOS:
        case AvailabilityWindow.SEMPRE:
          return "sempre disponível"
        default:
          return "sempre disponível"
      }
    }
  }

  // Fallback: env vars
  const lunchStart = process.env.RESTAURANT_LUNCH_START_HOUR || "11"
  const lunchEnd = process.env.RESTAURANT_LUNCH_END_HOUR || "15"
  const dinnerStart = process.env.RESTAURANT_DINNER_START_HOUR || "18"
  const dinnerEnd = process.env.RESTAURANT_DINNER_END_HOUR || "23"

  switch (availabilityWindow) {
    case AvailabilityWindow.ALMOCO:
      return `almoço (${lunchStart}h-${lunchEnd}h)`
    case AvailabilityWindow.JANTAR:
      return `jantar (${dinnerStart}h-${dinnerEnd}h)`
    case AvailabilityWindow.CONGELADOS:
    case AvailabilityWindow.SEMPRE:
      return "sempre disponível"
    default:
      return "sempre disponível"
  }
}
