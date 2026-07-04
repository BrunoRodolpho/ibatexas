// Public daily specials — no auth required (NEW-038 slice (a)).
//
// GET /api/specials/today — today's ACTIVE specials, resolved in RESTAURANT_TIMEZONE.
//
// The customer-facing READ over the DailySpecial data a manager authors via the
// NEW-005 admin surface (/api/admin/specials). This is the API contract the web
// menu / PromoTicker (NEW-038 (b)) and the chat grounding (NEW-038 (c)) consume —
// those surfaces are the remaining NEW-038 work; this ships the public read only.
//
// Mirrors the public banner route (routes/banner.ts): no auth, `rateLimit: false`,
// and an HTTP Cache-Control (30s) so the menu can poll cheaply. Only the customer-
// relevant fields are projected (productId + promo price + headline) — the internal
// row id / timestamps / active flag never leave the server. `getForDate` already
// filters to ACTIVE specials, so a paused special never surfaces.

import type { FastifyInstance } from "fastify";
import { createDailySpecialService } from "@ibatexas/domain";
import { todayInRestaurantTz } from "./admin/_date-defaults.js";

export async function specialsRoutes(server: FastifyInstance): Promise<void> {
  // Lazily construct on first request (NOT at registration) so a test mounting this
  // plugin with a partial `@ibatexas/domain` mock doesn't trip over a missing
  // factory at register time (mirrors the admin route plugins).
  let specialSvc: ReturnType<typeof createDailySpecialService> | undefined;
  const svc = () => (specialSvc ??= createDailySpecialService());

  server.get(
    "/api/specials/today",
    {
      config: { rateLimit: false },
      schema: { tags: ["specials"], summary: "Especiais do dia (público)" },
    },
    async (_request, reply) => {
      const rows = await svc().getForDate(todayInRestaurantTz());
      // Public projection — only the customer-relevant fields (never the internal
      // row id / timestamps / active flag).
      const specials = rows.map((s) => ({
        productId: s.medusaProductId,
        promoPriceCentavos: s.promoPriceCentavos,
        headline: s.headline,
      }));
      void reply.header("Cache-Control", "public, max-age=30").send({ specials });
    },
  );
}
