// admin/kitchen.ts — manager-gated read-only kitchen ticket board (NEW-010).
// A read-only surface over the KitchenService: every ACTIVE (pre-delivery,
// non-terminal) order with how long it has been waiting, so the kitchen works
// OLDEST-FIRST. NO mutations, NO querystring.
//
//   GET /api/admin/kitchen/tickets → KitchenBoard { now, tickets, queueDepth, totalActive }
//
// SCOPE: the "ticket-timing" half of NEW-010 (ticket age + time-in-status +
// queue depth). The pacing/throttle/capacity model is DEFERRED to NEW-039.
//
// Mirrors admin/analytics-reports.ts: `withTypeProvider<ZodTypeProvider>`, lazy
// service construction, and a `requireManagerRole` preHandler that fail-closes
// to 403.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { createKitchenService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";

export async function adminKitchenRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // the admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors analytics-reports.ts / caixa.ts).
  let kitchenSvc: ReturnType<typeof createKitchenService> | undefined;
  const svc = () => (kitchenSvc ??= createKitchenService());

  // ── GET /api/admin/kitchen/tickets — live kitchen ticket board ──────────────
  app.get(
    "/api/admin/kitchen/tickets",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Painel de comandas da cozinha (tempos de espera, mais antigo primeiro)",
      },
    },
    async (_request, reply) => {
      const board = await svc().getTickets();
      return reply.send(board);
    },
  );
}
