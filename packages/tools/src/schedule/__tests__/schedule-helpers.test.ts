// Unit tests for schedule/schedule-helpers.ts — pure, time-dependent functions.
//
// These helpers read the current instant via `new Date()` and convert it to a
// timezone-local time using `Intl.DateTimeFormat`. We pin the wall clock with
// `vi.setSystemTime(...)` (the established pattern in this package, see
// `src/__tests__/events-emitter.test.ts`) so every assertion is deterministic.
//
// Timezone under test: "America/Sao_Paulo" (UTC-3, no DST since 2019).
// Reference instants (UTC -> São Paulo local):
//   2026-06-29T16:00:00Z -> Mon 13:00 (lunch)      dayOfWeek=1
//   2026-06-29T23:30:00Z -> Mon 20:30 (dinner)     dayOfWeek=1
//   2026-06-29T19:00:00Z -> Mon 16:00 (between)    dayOfWeek=1
//   2026-06-29T09:00:00Z -> Mon 06:00 (pre-open)   dayOfWeek=1
//   2026-06-30T03:00:00Z -> Tue 00:00 (midnight)   dayOfWeek=2

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { RestaurantSchedule, DaySchedule, HolidayEntry } from "@ibatexas/domain"
import {
  getLocalTime,
  getTimeStr,
  getMealPeriodFromSchedule,
  isAvailableFromSchedule,
  getNextOpenDay,
  getFrozenPickupMessage,
} from "../schedule-helpers.js"

const TZ = "America/Sao_Paulo"

// Reference instants
const MON_LUNCH = "2026-06-29T16:00:00Z" // Mon 13:00
const MON_DINNER = "2026-06-29T23:30:00Z" // Mon 20:30
const MON_BETWEEN = "2026-06-29T19:00:00Z" // Mon 16:00
const MON_MORNING = "2026-06-29T09:00:00Z" // Mon 06:00
const TUE_MIDNIGHT = "2026-06-30T03:00:00Z" // Tue 00:00

// ── fixtures ──────────────────────────────────────────────────────────────────

function mkDay(dayOfWeek: number, overrides: Partial<DaySchedule> = {}): DaySchedule {
  return {
    dayOfWeek,
    isOpen: false,
    lunchStart: null,
    lunchEnd: null,
    dinnerStart: null,
    dinnerEnd: null,
    ...overrides,
  }
}

const STANDARD_OPEN: Partial<DaySchedule> = {
  isOpen: true,
  lunchStart: "11:00",
  lunchEnd: "15:00",
  dinnerStart: "18:00",
  dinnerEnd: "23:00",
}

function mkSchedule(days: DaySchedule[], holidays: HolidayEntry[] = []): RestaurantSchedule {
  return { days, holidays, overrides: [] }
}

function holiday(date: string): HolidayEntry {
  return { id: `h-${date}`, date, label: "Feriado", allDay: true, startTime: null, endTime: null }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── getLocalTime ──────────────────────────────────────────────────────────────

describe("getLocalTime", () => {
  it("returns the timezone-local hour/minute/dayOfWeek for a lunchtime instant", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    expect(getLocalTime(TZ)).toEqual({ hour: 13, minute: 0, dayOfWeek: 1 })
  })

  it("reflects minutes for a non-round instant", () => {
    vi.setSystemTime(new Date(MON_DINNER))
    expect(getLocalTime(TZ)).toEqual({ hour: 20, minute: 30, dayOfWeek: 1 })
  })

  it("normalizes midnight to hour 0 and rolls dayOfWeek to the next day", () => {
    // SP local midnight on Tue 2026-06-30.
    vi.setSystemTime(new Date(TUE_MIDNIGHT))
    const { hour, dayOfWeek } = getLocalTime(TZ)
    expect(hour).toBe(0)
    expect(dayOfWeek).toBe(2)
  })
})

// ── getTimeStr ────────────────────────────────────────────────────────────────

describe("getTimeStr", () => {
  it("zero-pads a single-digit hour", () => {
    vi.setSystemTime(new Date(MON_MORNING))
    expect(getTimeStr(TZ)).toBe("06:00")
  })

  it("formats a half-hour evening time", () => {
    vi.setSystemTime(new Date(MON_DINNER))
    expect(getTimeStr(TZ)).toBe("20:30")
  })
})

// ── getMealPeriodFromSchedule (env fallback, no DB schedule) ───────────────────

describe("getMealPeriodFromSchedule — env fallback (schedule undefined)", () => {
  const ENV_KEYS = [
    "RESTAURANT_LUNCH_START_HOUR",
    "RESTAURANT_LUNCH_END_HOUR",
    "RESTAURANT_DINNER_START_HOUR",
    "RESTAURANT_DINNER_END_HOUR",
  ] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("uses default lunch window 11–15 -> 'lunch' at 13:00", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    expect(getMealPeriodFromSchedule(undefined, TZ)).toBe("lunch")
  })

  it("uses default dinner window 18–23 -> 'dinner' at 20:30", () => {
    vi.setSystemTime(new Date(MON_DINNER))
    expect(getMealPeriodFromSchedule(undefined, TZ)).toBe("dinner")
  })

  it("returns 'closed' outside both default windows (06:00)", () => {
    vi.setSystemTime(new Date(MON_MORNING))
    expect(getMealPeriodFromSchedule(undefined, TZ)).toBe("closed")
  })

  it("honours env overrides — a shifted lunch window flips 13:00 to 'closed'", () => {
    // Default would be lunch at 13:00; overriding lunch to 14–16 makes 13:00 closed.
    process.env.RESTAURANT_LUNCH_START_HOUR = "14"
    process.env.RESTAURANT_LUNCH_END_HOUR = "16"
    vi.setSystemTime(new Date(MON_LUNCH))
    expect(getMealPeriodFromSchedule(undefined, TZ)).toBe("closed")
  })
})

// ── getMealPeriodFromSchedule (DB schedule) ───────────────────────────────────

describe("getMealPeriodFromSchedule — DB schedule", () => {
  // Monday (dayOfWeek=1) open with standard windows; other days irrelevant here.
  const mondayOpen = mkSchedule([mkDay(1, STANDARD_OPEN)])

  it("returns 'lunch' when the current minute is inside the lunch window", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    expect(getMealPeriodFromSchedule(mondayOpen, TZ)).toBe("lunch")
  })

  it("returns 'dinner' when the current minute is inside the dinner window", () => {
    vi.setSystemTime(new Date(MON_DINNER))
    expect(getMealPeriodFromSchedule(mondayOpen, TZ)).toBe("dinner")
  })

  it("returns 'closed' between the lunch and dinner windows", () => {
    vi.setSystemTime(new Date(MON_BETWEEN)) // 16:00
    expect(getMealPeriodFromSchedule(mondayOpen, TZ)).toBe("closed")
  })

  it("returns 'closed' when today's day is marked not open", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    const mondayClosed = mkSchedule([mkDay(1, { ...STANDARD_OPEN, isOpen: false })])
    expect(getMealPeriodFromSchedule(mondayClosed, TZ)).toBe("closed")
  })

  it("returns 'closed' when there is no schedule entry for today's day", () => {
    vi.setSystemTime(new Date(MON_LUNCH)) // Monday, but schedule only has Sunday
    const onlySunday = mkSchedule([mkDay(0, STANDARD_OPEN)])
    expect(getMealPeriodFromSchedule(onlySunday, TZ)).toBe("closed")
  })

  it("returns 'closed' on a holiday even during the lunch window", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    const withHoliday = mkSchedule([mkDay(1, STANDARD_OPEN)], [holiday("2026-06-29")])
    expect(getMealPeriodFromSchedule(withHoliday, TZ)).toBe("closed")
  })

  it("treats a window with a null bound as not-open (no lunch window)", () => {
    vi.setSystemTime(new Date(MON_LUNCH)) // 13:00
    const noLunchBound = mkSchedule([
      mkDay(1, { isOpen: true, lunchStart: null, lunchEnd: null, dinnerStart: "18:00", dinnerEnd: "23:00" }),
    ])
    expect(getMealPeriodFromSchedule(noLunchBound, TZ)).toBe("closed")
  })
})

// ── isAvailableFromSchedule ───────────────────────────────────────────────────

describe("isAvailableFromSchedule", () => {
  const mondayOpen = mkSchedule([mkDay(1, STANDARD_OPEN)])

  it("frozen products ('congelados') are always available, regardless of period", () => {
    vi.setSystemTime(new Date(MON_MORNING)) // closed period
    expect(isAvailableFromSchedule("congelados", mondayOpen, TZ)).toBe(true)
  })

  it("'sempre' products are always available", () => {
    vi.setSystemTime(new Date(MON_MORNING))
    expect(isAvailableFromSchedule("sempre", mondayOpen, TZ)).toBe(true)
  })

  it("'almoco' is available during the lunch period and not during dinner", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    expect(isAvailableFromSchedule("almoco", mondayOpen, TZ)).toBe(true)
    vi.setSystemTime(new Date(MON_DINNER))
    expect(isAvailableFromSchedule("almoco", mondayOpen, TZ)).toBe(false)
  })

  it("'jantar' is available during the dinner period and not during lunch", () => {
    vi.setSystemTime(new Date(MON_DINNER))
    expect(isAvailableFromSchedule("jantar", mondayOpen, TZ)).toBe(true)
    vi.setSystemTime(new Date(MON_LUNCH))
    expect(isAvailableFromSchedule("jantar", mondayOpen, TZ)).toBe(false)
  })

  it("an unrecognized availability window defaults to available", () => {
    vi.setSystemTime(new Date(MON_MORNING))
    expect(isAvailableFromSchedule("qualquer-coisa", mondayOpen, TZ)).toBe(true)
  })
})

// ── getNextOpenDay ────────────────────────────────────────────────────────────

describe("getNextOpenDay", () => {
  it("returns 'amanhã' when tomorrow is open and not a holiday", () => {
    vi.setSystemTime(new Date(MON_LUNCH)) // today Monday
    // Tuesday (dayOfWeek=2) is open.
    const sched = mkSchedule([mkDay(1, STANDARD_OPEN), mkDay(2, STANDARD_OPEN)])
    expect(getNextOpenDay(sched, TZ)).toBe("amanhã")
  })

  it("skips a closed tomorrow and names the next open weekday with DD/MM", () => {
    vi.setSystemTime(new Date(MON_LUNCH)) // today Monday 2026-06-29
    // Tuesday closed, Wednesday (dayOfWeek=3 / 2026-07-01) open.
    const sched = mkSchedule([
      mkDay(1, STANDARD_OPEN),
      mkDay(2, { isOpen: false }),
      mkDay(3, STANDARD_OPEN),
    ])
    expect(getNextOpenDay(sched, TZ)).toBe("quarta-feira (01/07)")
  })

  it("skips a holiday tomorrow even when that weekday is open", () => {
    vi.setSystemTime(new Date(MON_LUNCH)) // today Monday 2026-06-29
    // Tuesday 2026-06-30 is open BUT a holiday; Wednesday 2026-07-01 open.
    const sched = mkSchedule(
      [mkDay(1, STANDARD_OPEN), mkDay(2, STANDARD_OPEN), mkDay(3, STANDARD_OPEN)],
      [holiday("2026-06-30")],
    )
    expect(getNextOpenDay(sched, TZ)).toBe("quarta-feira (01/07)")
  })

  it("returns the 'em breve' fallback when no day is open within 14 days", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    const allClosed = mkSchedule([0, 1, 2, 3, 4, 5, 6].map((d) => mkDay(d, { isOpen: false })))
    expect(getNextOpenDay(allClosed, TZ)).toBe("em breve")
  })
})

// ── getFrozenPickupMessage ────────────────────────────────────────────────────

describe("getFrozenPickupMessage", () => {
  it("includes both lunch and dinner windows, formatted with stripped leading zeros", () => {
    vi.setSystemTime(new Date(MON_LUNCH)) // today Monday
    const sched = mkSchedule([mkDay(1, STANDARD_OPEN), mkDay(2, STANDARD_OPEN)])
    expect(getFrozenPickupMessage(sched, TZ)).toBe(
      "Retirada: amanhã, durante horário de funcionamento (11h–15h / 18h–23h).",
    )
  })

  it("renders half-hour minutes as Xh<MM> and a lunch-only day with a single window", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    // Tuesday open with a 09:30–11:30 lunch only (no dinner).
    const sched = mkSchedule([
      mkDay(1, STANDARD_OPEN),
      mkDay(2, { isOpen: true, lunchStart: "09:30", lunchEnd: "11:30", dinnerStart: null, dinnerEnd: null }),
    ])
    expect(getFrozenPickupMessage(sched, TZ)).toBe(
      "Retirada: amanhã, durante horário de funcionamento (9h30–11h30).",
    )
  })

  it("omits the hours clause when the next open day has no defined windows", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    const sched = mkSchedule([
      mkDay(1, STANDARD_OPEN),
      mkDay(2, { isOpen: true }), // open but all bounds null
    ])
    expect(getFrozenPickupMessage(sched, TZ)).toBe(
      "Retirada: amanhã, durante horário de funcionamento.",
    )
  })

  it("falls back to 'em breve' wording when nothing is open within 14 days", () => {
    vi.setSystemTime(new Date(MON_LUNCH))
    const allClosed = mkSchedule([0, 1, 2, 3, 4, 5, 6].map((d) => mkDay(d, { isOpen: false })))
    expect(getFrozenPickupMessage(allClosed, TZ)).toBe(
      "Retirada: em breve, durante horário de funcionamento.",
    )
  })
})
