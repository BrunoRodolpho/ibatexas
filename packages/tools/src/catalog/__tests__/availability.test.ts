// Tests for the shared availability-window logic.
//
// Covers both exported functions and every decision branch:
//   - isAvailableNow():            schedule path + env-var fallback path
//   - describeAvailabilityWindow(): describeFromSchedule (+ null fallback) + describeFromEnv
//
// Time is frozen with fake timers and the restaurant timezone is pinned to
// "UTC" so the timezone-derived hour / day-of-week / date string are fully
// deterministic (local time == UTC). No DB, network, Redis or LLM involved —
// these are pure synchronous functions.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { DaySchedule, HolidayEntry, RestaurantSchedule } from "@ibatexas/types"
import { AvailabilityWindow } from "@ibatexas/types"
import { isAvailableNow, describeAvailabilityWindow } from "../availability.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

// 2026-06-15 is a Monday (UTC dayOfWeek === 1); the en-CA date string is
// "2026-06-15". With RESTAURANT_TIMEZONE=UTC the local hour equals the UTC hour.
const MONDAY_LUNCH = new Date("2026-06-15T12:00:00.000Z") // hour 12 → lunch
const MONDAY_DINNER = new Date("2026-06-15T20:00:00.000Z") // hour 20 → dinner
const MONDAY_MIDNIGHT = new Date("2026-06-15T00:00:00.000Z") // hour 0 → closed
const TODAY_DATE_STR = "2026-06-15"

function makeDay(dayOfWeek: number, opts: Partial<DaySchedule> = {}): DaySchedule {
  return {
    dayOfWeek,
    isOpen: true,
    lunchStart: "11:00",
    lunchEnd: "15:00",
    dinnerStart: "18:00",
    dinnerEnd: "23:00",
    ...opts,
  }
}

/** A full 7-day schedule so the day lookup always resolves regardless of dow. */
function makeSchedule(
  opts: { dayOpts?: Partial<DaySchedule>; holidays?: HolidayEntry[] } = {},
): RestaurantSchedule {
  return {
    days: Array.from({ length: 7 }, (_, i) => makeDay(i, opts.dayOpts)),
    holidays: opts.holidays ?? [],
    overrides: [],
  }
}

const ENV_KEYS = [
  "RESTAURANT_TIMEZONE",
  "RESTAURANT_LUNCH_START_HOUR",
  "RESTAURANT_LUNCH_END_HOUR",
  "RESTAURANT_DINNER_START_HOUR",
  "RESTAURANT_DINNER_END_HOUR",
] as const

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  // Pin timezone; clear hour overrides so the documented defaults apply.
  process.env.RESTAURANT_TIMEZONE = "UTC"
  delete process.env.RESTAURANT_LUNCH_START_HOUR
  delete process.env.RESTAURANT_LUNCH_END_HOUR
  delete process.env.RESTAURANT_DINNER_START_HOUR
  delete process.env.RESTAURANT_DINNER_END_HOUR
  vi.useFakeTimers()
  vi.setSystemTime(MONDAY_LUNCH)
})

afterEach(() => {
  vi.useRealTimers()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ── isAvailableNow — env-var fallback (no schedule) ──────────────────────────

describe("isAvailableNow — env-var fallback (no schedule)", () => {
  it("ALMOCO is available during the lunch window", () => {
    vi.setSystemTime(MONDAY_LUNCH) // hour 12 ∈ [11,15)
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(true)
  })

  it("ALMOCO is unavailable outside the lunch window", () => {
    vi.setSystemTime(MONDAY_DINNER) // hour 20 ∉ [11,15)
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(false)
  })

  it("JANTAR is available during the dinner window", () => {
    vi.setSystemTime(MONDAY_DINNER) // hour 20 ∈ [18,23)
    expect(isAvailableNow(AvailabilityWindow.JANTAR)).toBe(true)
  })

  it("JANTAR is unavailable during the lunch window", () => {
    vi.setSystemTime(MONDAY_LUNCH) // hour 12 ∉ [18,23)
    expect(isAvailableNow(AvailabilityWindow.JANTAR)).toBe(false)
  })

  it("treats the lunch end-hour as exclusive (15:00 is closed)", () => {
    vi.setSystemTime(new Date("2026-06-15T15:00:00.000Z")) // hour 15, end is 15
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(false)
  })

  it("treats the lunch start-hour as inclusive (11:00 is open)", () => {
    vi.setSystemTime(new Date("2026-06-15T11:00:00.000Z")) // hour 11 === start
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(true)
  })

  it("CONGELADOS is always available, even at midnight", () => {
    vi.setSystemTime(MONDAY_MIDNIGHT)
    expect(isAvailableNow(AvailabilityWindow.CONGELADOS)).toBe(true)
  })

  it("SEMPRE is always available, even at midnight", () => {
    vi.setSystemTime(MONDAY_MIDNIGHT)
    expect(isAvailableNow(AvailabilityWindow.SEMPRE)).toBe(true)
  })

  it("midnight normalizes to hour 0 → ALMOCO closed", () => {
    vi.setSystemTime(MONDAY_MIDNIGHT) // hour 0 ∉ [11,15)
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(false)
  })

  it("an unrecognized window defaults to available", () => {
    vi.setSystemTime(MONDAY_MIDNIGHT)
    expect(isAvailableNow("promocao-relampago")).toBe(true)
  })

  it("honors custom lunch hours from env vars", () => {
    process.env.RESTAURANT_LUNCH_START_HOUR = "10"
    process.env.RESTAURANT_LUNCH_END_HOUR = "14"
    vi.setSystemTime(new Date("2026-06-15T13:00:00.000Z")) // hour 13 ∈ [10,14)
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(true)
    vi.setSystemTime(new Date("2026-06-15T14:00:00.000Z")) // hour 14 == end → closed
    expect(isAvailableNow(AvailabilityWindow.ALMOCO)).toBe(false)
  })
})

// ── isAvailableNow — DB schedule path ────────────────────────────────────────

describe("isAvailableNow — DB schedule", () => {
  it("ALMOCO open when the schedule period is lunch", () => {
    vi.setSystemTime(MONDAY_LUNCH)
    expect(isAvailableNow(AvailabilityWindow.ALMOCO, makeSchedule())).toBe(true)
  })

  it("ALMOCO closed when the schedule period is dinner", () => {
    vi.setSystemTime(MONDAY_DINNER)
    expect(isAvailableNow(AvailabilityWindow.ALMOCO, makeSchedule())).toBe(false)
  })

  it("JANTAR open when the schedule period is dinner", () => {
    vi.setSystemTime(MONDAY_DINNER)
    expect(isAvailableNow(AvailabilityWindow.JANTAR, makeSchedule())).toBe(true)
  })

  it("CONGELADOS is available even on a closed day", () => {
    vi.setSystemTime(MONDAY_LUNCH)
    const schedule = makeSchedule({ dayOpts: { isOpen: false } })
    expect(isAvailableNow(AvailabilityWindow.CONGELADOS, schedule)).toBe(true)
  })

  it("SEMPRE is available even on a closed day", () => {
    vi.setSystemTime(MONDAY_LUNCH)
    const schedule = makeSchedule({ dayOpts: { isOpen: false } })
    expect(isAvailableNow(AvailabilityWindow.SEMPRE, schedule)).toBe(true)
  })

  it("ALMOCO closed when today's day entry is marked closed", () => {
    vi.setSystemTime(MONDAY_LUNCH)
    const schedule = makeSchedule({ dayOpts: { isOpen: false } })
    expect(isAvailableNow(AvailabilityWindow.ALMOCO, schedule)).toBe(false)
  })

  it("ALMOCO closed when today is a holiday", () => {
    vi.setSystemTime(MONDAY_LUNCH)
    const holiday: HolidayEntry = {
      id: "h1",
      date: TODAY_DATE_STR,
      label: "Feriado",
      allDay: true,
      startTime: null,
      endTime: null,
    }
    const schedule = makeSchedule({ holidays: [holiday] })
    expect(isAvailableNow(AvailabilityWindow.ALMOCO, schedule)).toBe(false)
  })

  it("an unrecognized window with a schedule defaults to available", () => {
    vi.setSystemTime(MONDAY_LUNCH)
    expect(isAvailableNow("promocao-relampago", makeSchedule())).toBe(true)
  })
})

// ── describeAvailabilityWindow — env-var fallback (no schedule) ───────────────

describe("describeAvailabilityWindow — env-var fallback (no schedule)", () => {
  it("describes ALMOCO with the default lunch hours", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.ALMOCO)).toBe("almoço (11h-15h)")
  })

  it("describes JANTAR with the default dinner hours", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.JANTAR)).toBe("jantar (18h-23h)")
  })

  it("describes CONGELADOS as always available", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.CONGELADOS)).toBe("sempre disponível")
  })

  it("describes SEMPRE as always available", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.SEMPRE)).toBe("sempre disponível")
  })

  it("describes an unrecognized window as always available", () => {
    expect(describeAvailabilityWindow("promocao-relampago")).toBe("sempre disponível")
  })

  it("honors custom env hours in the description", () => {
    process.env.RESTAURANT_LUNCH_START_HOUR = "10"
    process.env.RESTAURANT_LUNCH_END_HOUR = "14"
    expect(describeAvailabilityWindow(AvailabilityWindow.ALMOCO)).toBe("almoço (10h-14h)")
  })
})

// ── describeAvailabilityWindow — DB schedule path ────────────────────────────

describe("describeAvailabilityWindow — DB schedule", () => {
  it("describes ALMOCO using today's scheduled lunch hours", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.ALMOCO, makeSchedule())).toBe(
      "almoço (11h-15h)",
    )
  })

  it("describes JANTAR using today's scheduled dinner hours", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.JANTAR, makeSchedule())).toBe(
      "jantar (18h-23h)",
    )
  })

  it("strips minutes from scheduled hours (whole-hour rendering)", () => {
    const schedule = makeSchedule({ dayOpts: { lunchStart: "11:30", lunchEnd: "14:45" } })
    expect(describeAvailabilityWindow(AvailabilityWindow.ALMOCO, schedule)).toBe("almoço (11h-14h)")
  })

  it("describes CONGELADOS as always available", () => {
    expect(describeAvailabilityWindow(AvailabilityWindow.CONGELADOS, makeSchedule())).toBe(
      "sempre disponível",
    )
  })

  it("falls back to a bare label when the day has no lunch hours", () => {
    const schedule = makeSchedule({ dayOpts: { lunchStart: null, lunchEnd: null } })
    expect(describeAvailabilityWindow(AvailabilityWindow.ALMOCO, schedule)).toBe("almoço")
  })

  it("falls back to a bare label when the day has no dinner hours", () => {
    const schedule = makeSchedule({ dayOpts: { dinnerStart: null, dinnerEnd: null } })
    expect(describeAvailabilityWindow(AvailabilityWindow.JANTAR, schedule)).toBe("jantar")
  })

  it("describes an unrecognized window with a schedule as always available", () => {
    expect(describeAvailabilityWindow("promocao-relampago", makeSchedule())).toBe(
      "sempre disponível",
    )
  })

  it("falls back to env description when no matching day entry exists", () => {
    // Empty days → describeFromSchedule returns null → env fallback.
    const schedule: RestaurantSchedule = { days: [], holidays: [], overrides: [] }
    expect(describeAvailabilityWindow(AvailabilityWindow.ALMOCO, schedule)).toBe("almoço (11h-15h)")
  })
})
