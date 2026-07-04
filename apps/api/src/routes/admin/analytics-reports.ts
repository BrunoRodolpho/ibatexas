// admin/analytics-reports.ts — manager-gated read-only order analytics (NEW-013 + NEW-033).
// A read-only surface over the OrderAnalyticsService: over a local-date range
// [from, to) it aggregates the EXISTING projections (OrderProjection + Payment),
// joined to recipe/BOM COGS, into best-sellers, refund activity and per-product
// margins. NO mutations.
//
//   GET /api/admin/analytics/top-items?from=&to=&limit=  → TopItem[]
//   GET /api/admin/analytics/refunds?from=&to=           → RefundAnalytics
//   GET /api/admin/analytics/margins?from=&to=           → MarginsReport
//
// SCOPE: top-items + refunds are the NEW-013 parts derivable from order data.
// Margins/COGS now EXIST too (NEW-033): NEW-035 added the Recipe/BOM + per-
// ingredient cost, so the margins endpoint joins in-window revenue to per-dish
// COGS (UNKNOWN when a dish has no recipe or an incomplete one). This file is
// separate from analytics.ts (`/analytics/summary`) — it adds endpoints, never
// duplicates it.
//
// Mirrors admin/caixa.ts: `withTypeProvider<ZodTypeProvider>`, a zod
// querystring, lazy service construction, and a `requireManagerRole` preHandler
// that fail-closes to 403. When `to` is omitted it defaults to tomorrow (so the
// [from, to) window includes today) and `from` to 30 days before that — both in
// the RESTAURANT_TIMEZONE, the SAME zone the service resolves the range boundary
// in, so a default range is the restaurant's business days (not the server's
// local days, which near UTC midnight would report the wrong day).

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createOrderAnalyticsService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { shiftYmd, todayInRestaurantTz } from "./_date-defaults.js";

const YMD = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const TopItemsQuery = z.object({
  // Range [from, to) — YYYY-MM-DD, from inclusive / to exclusive. Both optional;
  // default to a trailing 30-day window ending today in RESTAURANT_TIMEZONE.
  from: YMD.optional(),
  to: YMD.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const RefundsQuery = z.object({
  from: YMD.optional(),
  to: YMD.optional(),
});

const MarginsQuery = z.object({
  from: YMD.optional(),
  to: YMD.optional(),
});

/**
 * Resolve the effective [from, to) range. `to` is EXCLUSIVE, so an omitted `to`
 * defaults to tomorrow (today + 1) to include today; an omitted `from` defaults
 * to 30 days before the effective `to`. Both in RESTAURANT_TIMEZONE.
 */
function resolveRange(q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? shiftYmd(todayInRestaurantTz(), 1);
  const from = q.from ?? shiftYmd(to, -30);
  return { from, to };
}

export async function adminAnalyticsReportRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // the admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors caixa.ts / ops-alerts.ts).
  let analyticsSvc: ReturnType<typeof createOrderAnalyticsService> | undefined;
  const svc = () => (analyticsSvc ??= createOrderAnalyticsService());

  // ── GET /api/admin/analytics/top-items — best-sellers over a range ──────────
  app.get(
    "/api/admin/analytics/top-items",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Mais vendidos (top itens por período)",
        querystring: TopItemsQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof TopItemsQuery>;
      const range = resolveRange(q);
      const items = await svc().getTopItems(range, { limit: q.limit });
      return reply.send({ range, items });
    },
  );

  // ── GET /api/admin/analytics/refunds — refund count/total/trend over a range ─
  app.get(
    "/api/admin/analytics/refunds",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Análise de estornos (por período)",
        querystring: RefundsQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof RefundsQuery>;
      const range = resolveRange(q);
      const analytics = await svc().getRefundAnalytics(range);
      return reply.send(analytics);
    },
  );

  // ── GET /api/admin/analytics/margins — per-product margin (revenue − COGS) ───
  app.get(
    "/api/admin/analytics/margins",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Margens por produto (receita − CMV, por período)",
        querystring: MarginsQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof MarginsQuery>;
      const range = resolveRange(q);
      const report = await svc().getMargins(range);
      return reply.send(report);
    },
  );
}
