// Schedule-aware helpers — pure synchronous functions.
// Uses Intl.DateTimeFormat.formatToParts() for correct timezone conversion
// (replaces the broken `new Date(toLocaleString())` antipattern).

import type { DaySchedule, RestaurantSchedule } from "@ibatexas/domain"

// ── Timezone-correct local time ──────────────────────────────────────────────

/**
 * Get the current local time in the given timezone.
 * Uses Intl.DateTimeFormat.formatToParts() which correctly handles DST transitions.
 */
export function getLocalTime(tz: string): { hour: number; minute: number; dayOfWeek: number } {
  const now = new Date()
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  })
  const parts = dtf.formatToParts(now)

  let hour = 0
  let minute = 0
  for (const part of parts) {
    if (part.type === "hour") hour = Number.parseInt(part.value, 10)
    if (part.type === "minute") minute = Number.parseInt(part.value, 10)
  }
  // Intl hour12:false returns 24 for midnight in some engines — normalize
  if (hour === 24) hour = 0

  // Get dayOfWeek via separate formatter (0=Sun, 6=Sat)
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
  const dayStr = dayFmt.format(now)
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dayOfWeek = dayMap[dayStr] ?? now.getDay()

  return { hour, minute, dayOfWeek }
}

/**
 * Format current time as "HH:MM" in the given timezone.
 */
export function getTimeStr(tz: string): string {
  const { hour, minute } = getLocalTime(tz)
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

// ── Schedule-aware meal period ───────────────────────────────────────────────

/**
 * Determine current meal period from the database schedule.
 * Falls back to env vars when schedule is not provided.
 */
export function getMealPeriodFromSchedule(
  schedule: RestaurantSchedule | undefined,
  tz: string,
): "lunch" | "dinner" | "closed" {
  const { hour, minute, dayOfWeek } = getLocalTime(tz)
  const timeMinutes = hour * 60 + minute

  if (schedule) {
    const day = schedule.days.find((d) => d.dayOfWeek === dayOfWeek)
    if (!day || !day.isOpen) return "closed"

    // Check if today is a holiday
    const todayStr = getLocalDateStr(tz)
    if (schedule.holidays.some((h) => h.date === todayStr)) return "closed"

    if (day.lunchStart && day.lunchEnd) {
      const lunchStartMin = parseTimeToMinutes(day.lunchStart)
      const lunchEndMin = parseTimeToMinutes(day.lunchEnd)
      if (timeMinutes >= lunchStartMin && timeMinutes < lunchEndMin) return "lunch"
    }
    if (day.dinnerStart && day.dinnerEnd) {
      const dinnerStartMin = parseTimeToMinutes(day.dinnerStart)
      const dinnerEndMin = parseTimeToMinutes(day.dinnerEnd)
      if (timeMinutes >= dinnerStartMin && timeMinutes < dinnerEndMin) return "dinner"
    }
    return "closed"
  }

  // Fallback to env vars
  const lunchStart = Number.parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = Number.parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)

  if (hour >= lunchStart && hour < lunchEnd) return "lunch"
  if (hour >= dinnerStart && hour < dinnerEnd) return "dinner"
  return "closed"
}

// ── Schedule-aware availability check ────────────────────────────────────────

/**
 * Check if a product availability window is currently open, using the DB schedule.
 */
export function isAvailableFromSchedule(
  availabilityWindow: string,
  schedule: RestaurantSchedule | undefined,
  tz: string,
): boolean {
  // Frozen / always-available products are always available
  if (availabilityWindow === "congelados" || availabilityWindow === "sempre") return true

  const period = getMealPeriodFromSchedule(schedule, tz)

  if (availabilityWindow === "almoco") return period === "lunch"
  if (availabilityWindow === "jantar") return period === "dinner"

  return true
}

// ── Next open day for frozen pickup ──────────────────────────────────────────

const PT_DAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"] as const

/**
 * Find the next day the restaurant is open, skipping holidays and closed days.
 * Returns a human-readable string like "amanhã" or "segunda-feira (30/03)".
 */
export function getNextOpenDay(
  schedule: RestaurantSchedule,
  tz: string,
): string {
  const { dayOfWeek } = getLocalTime(tz)
  const todayDateStr = getLocalDateStr(tz)
  const holidayDates = new Set(schedule.holidays.map((h) => h.date))

  // Check up to 14 days ahead
  for (let offset = 1; offset <= 14; offset++) {
    const futureDate = addDays(todayDateStr, offset)
    const futureDow = (dayOfWeek + offset) % 7

    // Skip holidays
    if (holidayDates.has(futureDate)) continue

    // Skip closed days
    const day = schedule.days.find((d) => d.dayOfWeek === futureDow)
    if (!day || !day.isOpen) continue

    // Build human-readable string
    if (offset === 1) return "amanhã"

    const dayName = PT_DAY_NAMES[futureDow]
    const [, month, dayNum] = futureDate.split("-")
    return `${dayName} (${dayNum}/${month})`
  }

  return "em breve" // fallback — should not happen normally
}

/**
 * Build a pickup message for frozen products ordered after hours.
 * Returns something like: "Retirada: amanhã, durante horário de funcionamento (11h–15h / 18h–23h)."
 */
export function getFrozenPickupMessage(
  schedule: RestaurantSchedule,
  tz: string,
): string {
  const nextDay = getNextOpenDay(schedule, tz)
  const { dayOfWeek } = getLocalTime(tz)

  // Find the next open day's schedule to show hours
  const todayDateStr = getLocalDateStr(tz)
  const holidayDates = new Set(schedule.holidays.map((h) => h.date))

  for (let offset = 1; offset <= 14; offset++) {
    const futureDate = addDays(todayDateStr, offset)
    const futureDow = (dayOfWeek + offset) % 7
    if (holidayDates.has(futureDate)) continue
    const day = schedule.days.find((d) => d.dayOfWeek === futureDow)
    if (!day || !day.isOpen) continue

    const periods: string[] = []
    if (day.lunchStart && day.lunchEnd) {
      periods.push(`${stripLeadingZero(day.lunchStart)}–${stripLeadingZero(day.lunchEnd)}`)
    }
    if (day.dinnerStart && day.dinnerEnd) {
      periods.push(`${stripLeadingZero(day.dinnerStart)}–${stripLeadingZero(day.dinnerEnd)}`)
    }

    const hoursStr = periods.length > 0 ? ` (${periods.join(" / ")})` : ""
    return `Retirada: ${nextDay}, durante horário de funcionamento${hoursStr}.`
  }

  return `Retirada: ${nextDay}, durante horário de funcionamento.`
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function stripLeadingZero(time: string): string {
  // "09:00" → "9h" , "11:00" → "11h", "11:30" → "11h30"
  const [h, m] = time.split(":")
  const hour = Number.parseInt(h ?? "0", 10)
  const min = Number.parseInt(m ?? "0", 10)
  return min === 0 ? `${hour}h` : `${hour}h${String(min).padStart(2, "0")}`
}

/**
 * Get current local date as "YYYY-MM-DD" in the given timezone.
 */
function getLocalDateStr(tz: string): string {
  const now = new Date()
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tz }) // en-CA gives YYYY-MM-DD
  return dtf.format(now)
}

/**
 * Add days to a "YYYY-MM-DD" date string and return a new "YYYY-MM-DD" string.
 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z") // noon UTC to avoid date-shift
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split("T")[0]!
}
