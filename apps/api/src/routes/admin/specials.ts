// admin/specials.ts — the NEW-005 daily-specials / promo-of-the-day surface (ADMIN
// AUTHORING slice). Manager-gated REST over DailySpecialService: CRUD over a special (a
// Medusa finished-good featured for one business-day, optionally at a promo price with
// a pt-BR headline) + a "today's specials" convenience read.
//
//   GET    /api/admin/specials?date=&activeOnly=   → { specials }
//   GET    /api/admin/specials/today               → { date, specials }
//   POST   /api/admin/specials                      → 201 { special }
//   PATCH  /api/admin/specials/:id                  → 200 { special } | 404
//   DELETE /api/admin/specials/:id                  → 200 { special } | 404
//
// Mirrors admin/ingredients.ts: `withTypeProvider`, zod schemas, a lazily-constructed
// service (so a test mounting the plugin with a partial `@ibatexas/domain` mock doesn't
// trip over a missing factory at register time), and a `requireManagerRole` preHandler
// that fail-closes to 403.
//
// Plain CRUD (NOT kernel-adjudicated): daily specials are admin-ops authored config, not
// a customer money/safety path — the manager-gate IS the authority (mirrors ingredients
// / recipes). MONEY (`promoPriceCentavos`) is INTEGER CENTAVOS (Hard-Rule #2), never a
// float. `date` is a business-day LABEL (YYYY-MM-DD) resolved in RESTAURANT_TIMEZONE.
//
// SCOPE: the customer-facing menu/web + chat surfacing of these specials (rides
// grounding/claims — the harder half) is DEFERRED to NEW-038. No public/customer route
// is defined here.

import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createDailySpecialService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { todayInRestaurantTz } from "./_date-defaults.js";

// Business-day label YYYY-MM-DD (validated; resolved in RESTAURANT_TIMEZONE at the caller).
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date deve ser YYYY-MM-DD");

// Promo price in INTEGER CENTAVOS (Hard-Rule #2): a non-negative integer, never a float.
// On update it's ALSO nullable so an explicit `null` clears a previously-set promo price.
const PromoPriceCentavos = z.number().int().min(0);

// pt-BR promo blurb (Hard-Rule #4). Bounded length; nullable on update to clear it.
const Headline = z.string().min(1).max(280);

const IdParam = z.object({ id: z.string().min(1).max(256) });

// activeOnly is a query STRING — an explicit "true"/"false" enum (z.coerce.boolean
// would treat the string "false" as truthy). Omitted → list all.
const ListQuery = z.object({
  date: Ymd.optional(),
  activeOnly: z.enum(["true", "false"]).optional(),
});

const CreateBody = z.object({
  medusaProductId: z.string().min(1).max(256),
  date: Ymd,
  promoPriceCentavos: PromoPriceCentavos.optional(),
  headline: Headline.optional(),
  active: z.boolean().optional(),
});

const UpdateBody = z.object({
  medusaProductId: z.string().min(1).max(256).optional(),
  date: Ymd.optional(),
  // Nullable on update: an explicit `null` clears the promo price (back to "no discount").
  promoPriceCentavos: PromoPriceCentavos.nullable().optional(),
  // Nullable on update: an explicit `null` clears the headline.
  headline: Headline.nullable().optional(),
  active: z.boolean().optional(),
});

export async function specialRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting this
  // plugin with a partial `@ibatexas/domain` mock doesn't trip over a missing factory
  // at register time (mirrors ingredients.ts / recipes.ts).
  let specialSvc: ReturnType<typeof createDailySpecialService> | undefined;
  const svc = () => (specialSvc ??= createDailySpecialService());

  // Row-or-null 404 tail shared by PATCH / DELETE (DRY — keeps the two handlers from
  // repeating the same 404-or-send block).
  const sendRowOr404 = (reply: FastifyReply, special: unknown) => {
    if (!special) {
      return reply.code(404).send({ error: "daily_special_not_found" });
    }
    return reply.send({ special });
  };

  // ── GET /api/admin/specials — list (by date and/or active only) ──────────────
  app.get(
    "/api/admin/specials",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Especiais do dia — listar promoções (admin)",
        querystring: ListQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof ListQuery>;
      const specials = await svc().list({
        ...(q.date !== undefined ? { date: q.date } : {}),
        activeOnly: q.activeOnly === "true",
      });
      return reply.send({ specials });
    },
  );

  // ── GET /api/admin/specials/today — active specials for today (restaurant TZ) ─
  // Registered BEFORE the /:id routes so "today" is never parsed as an id.
  app.get(
    "/api/admin/specials/today",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Especiais do dia — promoções de hoje (admin)",
      },
    },
    async (_request, reply) => {
      const date = todayInRestaurantTz();
      const specials = await svc().getForDate(date);
      return reply.send({ date, specials });
    },
  );

  // ── POST /api/admin/specials — create ────────────────────────────────────────
  app.post(
    "/api/admin/specials",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Especiais do dia — criar promoção (admin)",
        body: CreateBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateBody>;
      const special = await svc().create({
        medusaProductId: body.medusaProductId,
        date: body.date,
        ...(body.promoPriceCentavos !== undefined ? { promoPriceCentavos: body.promoPriceCentavos } : {}),
        ...(body.headline !== undefined ? { headline: body.headline } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      });
      return reply.status(201).send({ special });
    },
  );

  // ── PATCH /api/admin/specials/:id — update ───────────────────────────────────
  app.patch(
    "/api/admin/specials/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Especiais do dia — atualizar promoção (admin)",
        params: IdParam,
        body: UpdateBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const body = request.body as z.infer<typeof UpdateBody>;
      const special = await svc().update(id, body);
      return sendRowOr404(reply, special);
    },
  );

  // ── DELETE /api/admin/specials/:id — remove ──────────────────────────────────
  app.delete(
    "/api/admin/specials/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Especiais do dia — remover promoção (admin)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const special = await svc().remove(id);
      return sendRowOr404(reply, special);
    },
  );
}
