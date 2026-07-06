// Admin schedule CRUD — restaurant weekly hours + holidays + per-date overrides.
//
// GET    /api/admin/schedule                — full schedule (days + holidays + overrides)
// PUT    /api/admin/schedule/weekly         — upsert all 7 days
// POST   /api/admin/schedule/holidays       — add a holiday
// DELETE /api/admin/schedule/holidays/:id   — remove a holiday
// GET    /api/admin/schedule/overrides      — list overrides (optional ?month=YYYY-MM)
// PUT    /api/admin/schedule/overrides/:date — upsert override for a date
// DELETE /api/admin/schedule/overrides/:date — remove override (revert to template)
//
// Every mutation invalidates the Redis cache so the bot picks up changes immediately.

import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createScheduleService } from "@ibatexas/domain";
import { invalidateScheduleCache } from "@ibatexas/tools";
import { requireManagerRole } from "../../middleware/staff-auth.js";

/**
 * Invalidate the schedule cache after an admin write and, if the DEL was
 * ultimately swallowed (circuit-open / transient Redis error, even after the
 * built-in retry), log a structured WARN so operators know the edit may take up
 * to the schedule-cache TTL to propagate. The admin write already succeeded, so
 * we NEVER fail the mutation on a failed invalidation — the TTL
 * (SCHEDULE_CACHE_TTL_SECONDS, default 300s) bounds how long the stale snapshot
 * can survive before the next read re-reads the DB.
 */
async function invalidateScheduleOrWarn(log: FastifyBaseLogger): Promise<void> {
  const { ok } = await invalidateScheduleCache();
  if (!ok) {
    log.warn(
      { event: "schedule_cache_invalidation_failed", cacheKey: "restaurant:schedule" },
      "Schedule cache invalidation failed after retry — schedule edit may take up to SCHEDULE_CACHE_TTL_SECONDS (default 300s) to propagate to the bot.",
    );
  }
}

const HolidayIdParams = z.object({ id: z.string().min(1) });

const TimePattern = z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM");
const DatePattern = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");

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
  date: DatePattern,
  label: z.string().min(1).max(100),
  allDay: z.boolean().optional().default(true),
  startTime: TimePattern.nullable().optional(),
  endTime: TimePattern.nullable().optional(),
});

const TimeBlockSchema = z.object({
  label: z.string().min(1).max(50),
  start: TimePattern,
  end: TimePattern,
});

const OverrideBody = z.object({
  isOpen: z.boolean(),
  blocks: z.array(TimeBlockSchema).max(10),
  note: z.string().max(200).nullable().optional(),
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
      preHandler: requireManagerRole,
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
      await invalidateScheduleOrWarn(request.log);
      return reply.send({ ok: true });
    },
  );

  // POST /api/admin/schedule/holidays
  app.post(
    "/api/admin/schedule/holidays",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Adicionar feriado (admin)",
        body: HolidayBody,
      },
    },
    async (request, reply) => {
      const svc = createScheduleService();
      const holiday = await svc.addHoliday(request.body);
      await invalidateScheduleOrWarn(request.log);
      return reply.code(201).send({ holiday });
    },
  );

  // DELETE /api/admin/schedule/holidays/:id
  app.delete(
    "/api/admin/schedule/holidays/:id",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Remover feriado (admin)",
        params: HolidayIdParams,
      },
    },
    async (request, reply) => {
      const svc = createScheduleService();
      await svc.removeHoliday(request.params.id);
      await invalidateScheduleOrWarn(request.log);
      return reply.send({ ok: true });
    },
  );

  // ── Schedule Overrides ──────────────────────────────────────────────────────

  // GET /api/admin/schedule/overrides?month=YYYY-MM
  app.get(
    "/api/admin/schedule/overrides",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar exceções de horário",
        querystring: z.object({
          month: z.string().regex(/^\d{4}-\d{2}$/, "Formato YYYY-MM").optional(),
        }),
      },
    },
    async (request, reply) => {
      const { month } = request.query as { month?: string };
      const svc = createScheduleService();
      const overrides = await svc.listOverrides(month);
      return reply.send({ overrides });
    },
  );

  // PUT /api/admin/schedule/overrides/:date
  app.put(
    "/api/admin/schedule/overrides/:date",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Criar/atualizar exceção de horário para uma data",
        params: z.object({ date: DatePattern }),
        body: OverrideBody,
      },
    },
    async (request, reply) => {
      const { date } = request.params as { date: string };
      const svc = createScheduleService();
      const override = await svc.upsertOverride(date, request.body);
      await invalidateScheduleOrWarn(request.log);
      return reply.send({ override });
    },
  );

  // DELETE /api/admin/schedule/overrides/:date
  app.delete(
    "/api/admin/schedule/overrides/:date",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Remover exceção (reverter ao padrão)",
        params: z.object({ date: DatePattern }),
      },
    },
    async (request, reply) => {
      const { date } = request.params as { date: string };
      const svc = createScheduleService();
      await svc.removeOverride(date);
      await invalidateScheduleOrWarn(request.log);
      return reply.send({ ok: true });
    },
  );
}
