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
}

export interface RestaurantSchedule {
  days: DaySchedule[]       // always 7 entries, indexed by dayOfWeek
  holidays: HolidayEntry[]  // sorted by date ascending
}
