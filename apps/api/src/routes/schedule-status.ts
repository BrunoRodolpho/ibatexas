// Public schedule status — no auth required.
//
// GET /api/schedule/status — current kitchen open/closed status
//
// Cached via Redis read-through (loadSchedule) + HTTP Cache-Control.
// Invalidated instantly when admin edits hours or holidays.

import type { FastifyInstance } from "fastify";
import { loadSchedule, getMealPeriodFromSchedule, getNextOpenDay } from "@ibatexas/tools";

export async function scheduleStatusRoutes(server: FastifyInstance): Promise<void> {
  server.get(
    "/api/schedule/status",
    {
      config: { rateLimit: false },
      schema: { tags: ["schedule"], summary: "Status da cozinha (público)" },
    },
    async (_request, reply) => {
      const schedule = await loadSchedule();
      const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
      const mealPeriod = getMealPeriodFromSchedule(schedule, tz);

      const nextOpenDay = mealPeriod === "closed" ? getNextOpenDay(schedule, tz) : null;

      void reply
        .header("Cache-Control", "public, max-age=30")
        .send({ mealPeriod, nextOpenDay });
    },
  );
}
