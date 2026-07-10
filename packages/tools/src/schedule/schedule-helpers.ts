// Schedule-aware helpers — pure synchronous functions.
// Uses Intl.DateTimeFormat.formatToParts() for correct timezone conversion
// (replaces the broken `new Date(toLocaleString())` antipattern).

import type { RestaurantSchedule } from "@ibatexas/domain"

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

  if (!schedule) return mealPeriodFromEnv(hour)

  const day = schedule.days.find((d) => d.dayOfWeek === dayOfWeek)
  if (!day?.isOpen) return "closed"

  // Check if today is a holiday
  const todayStr = getLocalDateStr(tz)
  if (schedule.holidays.some((h) => h.date === todayStr)) return "closed"

  if (isWithinTimeWindow(timeMinutes, day.lunchStart, day.lunchEnd)) return "lunch"
  if (isWithinTimeWindow(timeMinutes, day.dinnerStart, day.dinnerEnd)) return "dinner"
  return "closed"
}

/** True when `timeMinutes` falls inside the [start, end) window, if both bounds exist. */
function isWithinTimeWindow(
  timeMinutes: number,
  start: string | null,
  end: string | null,
): boolean {
  if (!start || !end) return false
  const startMin = parseTimeToMinutes(start)
  const endMin = parseTimeToMinutes(end)
  return timeMinutes >= startMin && timeMinutes < endMin
}

/** Env-var fallback meal period when no DB schedule is provided. */
function mealPeriodFromEnv(hour: number): "lunch" | "dinner" | "closed" {
  const lunchStart = Number.parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = Number.parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)

  if (hour >= lunchStart && hour < lunchEnd) return "lunch"
  if (hour >= dinnerStart && hour < dinnerEnd) return "dinner"
  return "closed"
}

// ── Structured open/closed signal ────────────────────────────────────────────

/**
 * A STRUCTURED (not free-text) open/closed signal for the conversational loop.
 * The planner + responder consume `isClosed` deterministically — the agent must
 * never assert "estamos abertos" while this says the store is closed. Sourced
 * from {@link getMealPeriodFromSchedule}; when closed, `nextOpenDay` carries the
 * human-readable reopen day from {@link getNextOpenDay}.
 */
export interface ScheduleSignal {
  readonly isClosed: boolean
  readonly mealPeriod: "lunch" | "dinner" | "closed"
  /** Human-readable next opening (e.g. "amanhã") — present only when closed. */
  readonly nextOpenDay?: string
}

/**
 * Build the deterministic {@link ScheduleSignal} for "now" in the given tz. This
 * is the single source of the closed-hours fact the agent loop grounds on (the
 * soft prompt note + the deterministic backstop both read `isClosed`).
 */
export function getScheduleSignal(
  schedule: RestaurantSchedule | undefined,
  tz: string,
): ScheduleSignal {
  const mealPeriod = getMealPeriodFromSchedule(schedule, tz)
  const isClosed = mealPeriod === "closed"
  if (isClosed && schedule) {
    return { isClosed, mealPeriod, nextOpenDay: getNextOpenDay(schedule, tz) }
  }
  return { isClosed, mealPeriod }
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
    if (!day?.isOpen) continue

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
    if (!day?.isOpen) continue

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

// ── Today's operating-hours string (BKL-121 — the STORE_HOURS claim value) ─────

/**
 * Format TODAY's regular operating-hours as ONE scalar pt-BR string (BKL-121 / D2:
 * the renderer's proposition grammar is scalar-only). Reads ONLY the REAL weekly
 * `days[today]` window fields (lunch/dinner Start/End) via the SAME
 * {@link stripLeadingZero} idiom {@link getFrozenPickupMessage} uses — NEVER an
 * invented or hardcoded hour (Hard Rule #3 + the BKL-026 "Não invente um horário"
 * rule: the value is evidence-bound). Returns:
 *
 *   - `"11h–15h / 18h–23h"` — the day's open window(s), one or both meal periods;
 *   - `"fechado"`           — a regular CLOSED weekday (`isOpen=false`, or no
 *                             window) per the weekly schedule — an evidence-bound
 *                             fact, not an absence;
 *   - `null`                — the schedule is UNAVAILABLE (`undefined`). The caller
 *                             MUST record a fail-closed read ERROR (Inv 7), NEVER a
 *                             fabricated hours string.
 *
 * This is the WEEKLY-schedule fact ONLY. A per-date holiday or override is
 * deliberately NOT applied here — those are the STORE_HOURS claim's honest
 * FALSIFIERS (BKL-121 D1): the investigator records them separately and the kernel
 * demotes the claim to UNKNOWN when either fires (the weekly hours cannot be
 * trusted on an exception day). Pure: no clock beyond {@link getLocalTime}, no IO.
 */
export function getTodayHoursText(
  schedule: RestaurantSchedule | undefined,
  tz: string,
): string | null {
  if (!schedule) return null
  const { dayOfWeek } = getLocalTime(tz)
  const day = schedule.days.find((d) => d.dayOfWeek === dayOfWeek)
  if (!day?.isOpen) return "fechado"

  const periods: string[] = []
  if (day.lunchStart && day.lunchEnd) {
    periods.push(`${stripLeadingZero(day.lunchStart)}–${stripLeadingZero(day.lunchEnd)}`)
  }
  if (day.dinnerStart && day.dinnerEnd) {
    periods.push(`${stripLeadingZero(day.dinnerStart)}–${stripLeadingZero(day.dinnerEnd)}`)
  }
  return periods.length > 0 ? periods.join(" / ") : "fechado"
}

// ── A SPECIFIC DATE's operating-hours string (BKL-138 — STORE_HOURS_FOR_DATE) ───

/**
 * Format the operating-hours for a SPECIFIC ISO date (`"YYYY-MM-DD"`) as ONE
 * scalar pt-BR string — the day-parameterized twin of {@link getTodayHoursText}
 * (BKL-138 / SCN-002/003). A thin wrapper over the SAME weekly
 * `schedule.days.find(dayOfWeek)` lookup + `stripLeadingZero` window formatting;
 * the ONLY difference is that the `dayOfWeek` comes from the CALENDAR date rather
 * than from the clock, so a named-weekday / "amanhã" question can be answered off
 * the exact day the customer asked about. Returns the SAME value grammar as
 * {@link getTodayHoursText}:
 *
 *   - `"11h–15h / 18h–23h"` — the day's open window(s);
 *   - `"fechado"`           — a regular CLOSED weekday per the weekly schedule;
 *   - `null`                — the schedule is UNAVAILABLE (`undefined`). The caller
 *                             MUST record a fail-closed read ERROR (Inv 7).
 *
 * Like {@link getTodayHoursText}, this is the WEEKLY-schedule fact ONLY: a per-date
 * holiday or override on `isoDate` is deliberately NOT applied here — those are the
 * STORE_HOURS_FOR_DATE claim's honest FALSIFIERS (BKL-121 D1 / BKL-138), read + keyed
 * by the SAME `isoDate` so a holiday ON the queried date demotes the claim to UNKNOWN
 * while TODAY's holiday can never poison a future-date answer.
 *
 * The `dayOfWeek` of a calendar date is timezone-INDEPENDENT (a date IS a given
 * weekday everywhere), so `tz` is accepted for signature parity with
 * {@link getTodayHoursText} (and so a future tz-sensitive refinement has a seam) but
 * is not consulted for the lookup — the caller already resolved `isoDate` in `tz`.
 * Pure: no clock, no IO.
 */
export function getHoursTextForDate(
  schedule: RestaurantSchedule | undefined,
  tz: string,
  isoDate: string,
): string | null {
  void tz // see doc: the DOW of a fixed calendar date is tz-independent.
  if (!schedule) return null
  const dayOfWeek = dayOfWeekForIsoDate(isoDate)
  const day = schedule.days.find((d) => d.dayOfWeek === dayOfWeek)
  if (!day?.isOpen) return "fechado"

  const periods: string[] = []
  if (day.lunchStart && day.lunchEnd) {
    periods.push(`${stripLeadingZero(day.lunchStart)}–${stripLeadingZero(day.lunchEnd)}`)
  }
  if (day.dinnerStart && day.dinnerEnd) {
    periods.push(`${stripLeadingZero(day.dinnerStart)}–${stripLeadingZero(day.dinnerEnd)}`)
  }
  return periods.length > 0 ? periods.join(" / ") : "fechado"
}

/** Day-of-week (0=Sun … 6=Sat) for a `"YYYY-MM-DD"` ISO date. Noon-UTC anchors it
 *  away from any date-shift edge (mirrors the `addDays` idiom below). */
function dayOfWeekForIsoDate(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay()
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
