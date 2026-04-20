// ScheduleService — manages restaurant weekly schedule and holidays.
// Follows the createXxxService() factory pattern (see delivery-zone.service.ts).

import { prisma } from "../client.js"
import type { Prisma } from "../generated/prisma-client/client.js"
import type { DaySchedule, HolidayEntry, ScheduleOverrideEntry, TimeBlock, RestaurantSchedule } from "@ibatexas/types"

// Re-export types for consumers that import from domain
export type { DaySchedule, HolidayEntry, ScheduleOverrideEntry, TimeBlock, RestaurantSchedule }

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
        allDay: r.allDay,
        startTime: r.startTime,
        endTime: r.endTime,
      }))
    },

    async addHoliday(data: {
      date: string;
      label: string;
      allDay?: boolean;
      startTime?: string | null;
      endTime?: string | null;
    }): Promise<HolidayEntry> {
      const row = await prisma.holiday.create({
        data: {
          date: new Date(data.date + "T12:00:00Z"), // noon UTC to avoid date shift
          label: data.label,
          allDay: data.allDay ?? true,
          startTime: data.allDay === false ? (data.startTime ?? null) : null,
          endTime: data.allDay === false ? (data.endTime ?? null) : null,
        },
      })
      return {
        id: row.id,
        date: row.date.toISOString().split("T")[0]!,
        label: row.label,
        allDay: row.allDay,
        startTime: row.startTime,
        endTime: row.endTime,
      }
    },

    async removeHoliday(id: string): Promise<void> {
      await prisma.holiday.delete({ where: { id } })
    },

    // ── Overrides ──────────────────────────────────────────────────────

    async listOverrides(month?: string): Promise<ScheduleOverrideEntry[]> {
      const where: Record<string, unknown> = {}
      if (month) {
        // month = "YYYY-MM"
        const start = new Date(`${month}-01T00:00:00Z`)
        const end = new Date(start)
        end.setUTCMonth(end.getUTCMonth() + 1)
        where.date = { gte: start, lt: end }
      }
      const rows = await prisma.scheduleOverride.findMany({ where, orderBy: { date: "asc" } })
      return rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString().split("T")[0]!,
        isOpen: r.isOpen,
        blocks: (r.blocks as unknown as TimeBlock[]) ?? [],
        note: r.note,
      }))
    },

    async upsertOverride(
      date: string,
      data: { isOpen: boolean; blocks: TimeBlock[]; note?: string | null },
    ): Promise<ScheduleOverrideEntry> {
      const dateObj = new Date(date + "T12:00:00Z")
      const row = await prisma.scheduleOverride.upsert({
        where: { date: dateObj },
        create: { date: dateObj, isOpen: data.isOpen, blocks: data.blocks as unknown as Prisma.InputJsonValue, note: data.note ?? null },
        update: { isOpen: data.isOpen, blocks: data.blocks as unknown as Prisma.InputJsonValue, note: data.note ?? null },
      })
      return {
        id: row.id,
        date: row.date.toISOString().split("T")[0]!,
        isOpen: row.isOpen,
        blocks: (row.blocks as unknown as TimeBlock[]) ?? [],
        note: row.note,
      }
    },

    async removeOverride(date: string): Promise<void> {
      const dateObj = new Date(date + "T12:00:00Z")
      await prisma.scheduleOverride.delete({ where: { date: dateObj } }).catch(() => {
        // Ignore if not found
      })
    },

    async getFullSchedule(): Promise<RestaurantSchedule> {
      const [days, holidays, overrides] = await Promise.all([
        this.getWeeklySchedule(),
        this.listHolidays(),
        this.listOverrides(),
      ])
      return { days, holidays, overrides }
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
