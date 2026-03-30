// ScheduleService — manages restaurant weekly schedule and holidays.
// Follows the createXxxService() factory pattern (see delivery-zone.service.ts).

import { prisma } from "../client.js"
import type { DaySchedule, HolidayEntry, RestaurantSchedule } from "@ibatexas/types"

// Re-export types for consumers that import from domain
export type { DaySchedule, HolidayEntry, RestaurantSchedule }

// ── Day names for reference ──────────────────────────────────────────────────

const DAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const
export { DAY_NAMES }

// ── Service ───────────────────────────────────────────────────────────────────

export function createScheduleService() {
  return {
    async getWeeklySchedule(): Promise<DaySchedule[]> {
      const rows = await prisma.weeklySchedule.findMany({
        orderBy: { dayOfWeek: "asc" },
      })
      return rows.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        isOpen: r.isOpen,
        lunchStart: r.lunchStart,
        lunchEnd: r.lunchEnd,
        dinnerStart: r.dinnerStart,
        dinnerEnd: r.dinnerEnd,
      }))
    },

    async upsertDay(
      dayOfWeek: number,
      data: Omit<DaySchedule, "dayOfWeek">,
    ): Promise<void> {
      await prisma.weeklySchedule.upsert({
        where: { dayOfWeek },
        create: { dayOfWeek, ...data },
        update: data,
      })
    },

    async listHolidays(): Promise<HolidayEntry[]> {
      const rows = await prisma.holiday.findMany({
        orderBy: { date: "asc" },
      })
      return rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString().split("T")[0]!,
        label: r.label,
      }))
    },

    async addHoliday(data: { date: string; label: string }): Promise<HolidayEntry> {
      const row = await prisma.holiday.create({
        data: {
          date: new Date(data.date + "T12:00:00Z"), // noon UTC to avoid date shift
          label: data.label,
        },
      })
      return {
        id: row.id,
        date: row.date.toISOString().split("T")[0]!,
        label: row.label,
      }
    },

    async removeHoliday(id: string): Promise<void> {
      await prisma.holiday.delete({ where: { id } })
    },

    async getFullSchedule(): Promise<RestaurantSchedule> {
      const [days, holidays] = await Promise.all([
        this.getWeeklySchedule(),
        this.listHolidays(),
      ])
      return { days, holidays }
    },

    /**
     * Seed weekly schedule from env vars if the table is empty.
     * Called once on API startup — no-op if rows already exist.
     */
    async seedFromEnv(): Promise<void> {
      const count = await prisma.weeklySchedule.count()
      if (count > 0) return

      const lunchStart = (process.env.RESTAURANT_LUNCH_START_HOUR ?? "11").padStart(2, "0") + ":00"
      const lunchEnd = (process.env.RESTAURANT_LUNCH_END_HOUR ?? "15").padStart(2, "0") + ":00"
      const dinnerStart = (process.env.RESTAURANT_DINNER_START_HOUR ?? "18").padStart(2, "0") + ":00"
      const dinnerEnd = (process.env.RESTAURANT_DINNER_END_HOUR ?? "23").padStart(2, "0") + ":00"

      const data = Array.from({ length: 7 }, (_, i) => ({
        dayOfWeek: i,
        isOpen: true,
        lunchStart,
        lunchEnd,
        dinnerStart,
        dinnerEnd,
      }))

      await prisma.weeklySchedule.createMany({ data })
    },
  }
}

export type ScheduleService = ReturnType<typeof createScheduleService>
