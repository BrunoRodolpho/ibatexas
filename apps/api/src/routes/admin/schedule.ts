// Admin schedule CRUD — restaurant weekly hours + holidays.
//
// GET    /api/admin/schedule              — full schedule (days + holidays)
// PUT    /api/admin/schedule/weekly       — upsert all 7 days
// POST   /api/admin/schedule/holidays     — add a holiday
// DELETE /api/admin/schedule/holidays/:id — remove a holiday
//
// Every mutation invalidates the Redis cache so the bot picks up changes immediately.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createScheduleService } from "@ibatexas/domain";
import { invalidateScheduleCache } from "@ibatexas/tools";

const HolidayIdParams = z.object({ id: z.string().min(1) });

const TimePattern = z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM");

const DayScheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  lunchStart: TimePattern.nullable(),
  lunchEnd: TimePattern.nullable(),
  dinnerStart: TimePattern.nullable(),
  dinnerEnd: TimePattern.nullable(),
});

const WeeklyBody = z.object({
  days: z.array(DayScheduleSchema).length(7),
});

const HolidayBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD"),
  label: z.string().min(1).max(100),
});

export async function scheduleRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // GET /api/admin/schedule
  app.get(
    "/api/admin/schedule",
    {
      schema: { tags: ["admin"], summary: "Horários e feriados (admin)" },
    },
    async (_request, reply) => {
      const svc = createScheduleService();
      const schedule = await svc.getFullSchedule();
      return reply.send(schedule);
    },
  );

  // PUT /api/admin/schedule/weekly
  app.put(
    "/api/admin/schedule/weekly",
    {
      schema: {
        tags: ["admin"],
        summary: "Salvar horários semanais (admin)",
        body: WeeklyBody,
      },
    },
    async (request, reply) => {
      const svc = createScheduleService();
      for (const day of request.body.days) {
        const { dayOfWeek, ...data } = day;
        await svc.upsertDay(dayOfWeek, data);
      }
      await invalidateScheduleCache();
      return reply.send({ ok: true });
    },
  );

  // POST /api/admin/schedule/holidays
  app.post(
    "/api/admin/schedule/holidays",
    {
      schema: {
        tags: ["admin"],
        summary: "Adicionar feriado (admin)",
        body: HolidayBody,
      },
    },
    async (request, reply) => {
      const svc = createScheduleService();
      const holiday = await svc.addHoliday(request.body);
      await invalidateScheduleCache();
      return reply.code(201).send({ holiday });
    },
  );

  // DELETE /api/admin/schedule/holidays/:id
  app.delete(
    "/api/admin/schedule/holidays/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Remover feriado (admin)",
        params: HolidayIdParams,
      },
    },
    async (request, reply) => {
      const svc = createScheduleService();
      await svc.removeHoliday(request.params.id);
      await invalidateScheduleCache();
      return reply.send({ ok: true });
    },
  );
}
