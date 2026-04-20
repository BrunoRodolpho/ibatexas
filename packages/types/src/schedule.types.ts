// Schedule types — shared between domain (service) and llm-provider (consumer).

export interface DaySchedule {
  dayOfWeek: number
  isOpen: boolean
  lunchStart: string | null
  lunchEnd: string | null
  dinnerStart: string | null
  dinnerEnd: string | null
}

export interface HolidayEntry {
  id: string
  date: string // "2026-12-25" ISO date
  label: string
  allDay: boolean
  startTime: string | null // "HH:MM" — only when allDay=false
  endTime: string | null   // "HH:MM" — only when allDay=false
}

export interface TimeBlock {
  label: string   // "Almoço", "Jantar", "Café", etc.
  start: string   // "HH:MM"
  end: string     // "HH:MM"
}

export interface ScheduleOverrideEntry {
  id: string
  date: string           // "YYYY-MM-DD"
  isOpen: boolean
  blocks: TimeBlock[]
  note: string | null
}

export interface RestaurantSchedule {
  days: DaySchedule[]               // always 7 entries, indexed by dayOfWeek
  holidays: HolidayEntry[]          // sorted by date ascending
  overrides: ScheduleOverrideEntry[] // per-date exceptions
}
