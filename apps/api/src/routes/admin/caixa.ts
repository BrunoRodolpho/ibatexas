// admin/caixa.ts — the manager-gated caixa / day-close reconciliation (NEW-011).
// Read-only surface over the DayCloseService: for one local calendar day it
// aggregates the EXISTING projections (OrderProjection + Payment) into
// { orders, settled (by pix/card/cash), refunds, net }. NO mutations.
//
// Mirrors admin/ops-alerts.ts: `withTypeProvider<ZodTypeProvider>`, a zod
// querystring, lazy service construction, and a `requireManagerRole` preHandler
// that fail-closes to 403. When `date` is omitted it defaults to today in the
// RESTAURANT_TIMEZONE — the SAME zone the DayCloseService resolves the day
// boundary in, so "today's caixa" is the restaurant's current business day (not
// the server's local day, which near UTC midnight would report the wrong day).

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createDayCloseService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { todayInRestaurantTz } from "./_date-defaults.js";

const DayCloseQuery = z.object({
  // Local calendar day. Optional — defaults to today in RESTAURANT_TIMEZONE.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

export async function adminCaixaRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // the admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors ops-alerts.ts / incidents.ts).
  let dayCloseSvc: ReturnType<typeof createDayCloseService> | undefined;
  const svc = () => (dayCloseSvc ??= createDayCloseService());

  // ── GET /api/admin/caixa/day-close — one-day reconciliation summary ──────────
  app.get(
    "/api/admin/caixa/day-close",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fechamento de caixa (resumo do dia)",
        querystring: DayCloseQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof DayCloseQuery>;
      const date = q.date ?? todayInRestaurantTz();
      const summary = await svc().getDaySummary(date);
      return reply.send(summary);
    },
  );
}
