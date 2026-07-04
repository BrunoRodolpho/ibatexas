// admin/ingredients.ts — the NEW-003 raw-ingredient inventory surface (stock
// slice). Manager-gated REST over IngredientService: CRUD + adjust stock + a
// low-stock read.
//
//   GET    /api/admin/ingredients?activeOnly=       → { ingredients }
//   GET    /api/admin/ingredients/low-stock         → { ingredients }
//   POST   /api/admin/ingredients                    → 201 { ingredient }
//   PATCH  /api/admin/ingredients/:id                → 200 { ingredient } | 404
//   DELETE /api/admin/ingredients/:id                → 200 { ingredient } | 404
//   POST   /api/admin/ingredients/:id/adjust         → 200 { ingredient } | 404  (body: { deltaMilli })
//
// NEW-035 adds an optional per-unit cost (costCentavosPerUnit, integer centavos) to
// create/update — an ingredient's cost feeds a recipe's COGS read (recipe.service).
//
// Mirrors admin/tables.ts + admin/schedule-shifts.ts: `withTypeProvider`, zod
// schemas, a lazily-constructed service (so a test mounting the plugin with a
// partial `@ibatexas/domain` mock doesn't trip over a missing factory at register
// time), and a `requireManagerRole` preHandler that fail-closes to 403.
//
// Plain CRUD (NOT kernel-adjudicated): raw-ingredient stock is admin-ops, not a
// customer money/safety path — the manager-gate IS the authority here (mirrors
// tables / escala). Recipe/BOM linkage, per-dish depletion and COGS are DEFERRED.
//
// QUANTITIES are SCALED INTEGERS in milli-units (thousandths of `unit`): 2.5 kg →
// 2500 — precise, never a float. `unit` is a free-form column but validated here
// against the known restaurant measure set (extending it is a route-only change,
// no migration). `deltaMilli` on /adjust MAY be negative (subtract stock); the
// service clamps the result at 0.

import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createIngredientService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";

// Free-form `unit` column, validated at the route against the known measure set.
const UNITS = ["kg", "g", "un", "L", "mL"] as const;
const Unit = z.enum(UNITS);

// Milli-unit quantity: a non-negative integer (thousandths of the unit).
const MilliQty = z.number().int().min(0);

// NEW-035 — per-unit cost in INTEGER CENTAVOS (of one whole `unit`): a non-negative
// integer. Money is never a float. On create it's optional (omit = no cost set); on
// update it's ALSO nullable so an explicit `null` clears a previously-set cost.
const CostCentavos = z.number().int().min(0);

const IdParam = z.object({ id: z.string().min(1).max(256) });

// activeOnly is a query STRING — an explicit "true"/"false" enum (z.coerce.boolean
// would treat the string "false" as truthy). Omitted → list all.
const ListQuery = z.object({
  activeOnly: z.enum(["true", "false"]).optional(),
});

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  unit: Unit,
  stockMilli: MilliQty.optional(),
  lowStockMilli: MilliQty.optional(),
  costCentavosPerUnit: CostCentavos.optional(),
  active: z.boolean().optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  unit: Unit.optional(),
  stockMilli: MilliQty.optional(),
  lowStockMilli: MilliQty.optional(),
  // Nullable on update: an explicit `null` clears the cost (back to "no cost set").
  costCentavosPerUnit: CostCentavos.nullable().optional(),
  active: z.boolean().optional(),
});

// deltaMilli MAY be negative (subtract stock) — the service clamps at 0.
const AdjustBody = z.object({ deltaMilli: z.number().int() });

export async function ingredientRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting this
  // plugin with a partial `@ibatexas/domain` mock doesn't trip over a missing
  // factory at register time (mirrors schedule-shifts.ts / analytics-reports.ts).
  let ingredientSvc: ReturnType<typeof createIngredientService> | undefined;
  const svc = () => (ingredientSvc ??= createIngredientService());

  // Row-or-null 404 tail shared by PATCH / DELETE / adjust (DRY — keeps the three
  // handlers from repeating the same 404-or-send block).
  const sendRowOr404 = (reply: FastifyReply, ingredient: unknown) => {
    if (!ingredient) {
      return reply.code(404).send({ error: "ingredient_not_found" });
    }
    return reply.send({ ingredient });
  };

  // ── GET /api/admin/ingredients — list (all, or active only) ──────────────────
  app.get(
    "/api/admin/ingredients",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Insumos — listar ingredientes (admin)",
        querystring: ListQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof ListQuery>;
      const ingredients = await svc().list({ activeOnly: q.activeOnly === "true" });
      return reply.send({ ingredients });
    },
  );

  // ── GET /api/admin/ingredients/low-stock — at/below threshold (active) ────────
  // Registered BEFORE the /:id routes so "low-stock" is never parsed as an id.
  app.get(
    "/api/admin/ingredients/low-stock",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Insumos — ingredientes com estoque baixo (admin)",
      },
    },
    async (_request, reply) => {
      const ingredients = await svc().listLowStock();
      return reply.send({ ingredients });
    },
  );

  // ── POST /api/admin/ingredients — create ─────────────────────────────────────
  app.post(
    "/api/admin/ingredients",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Insumos — criar ingrediente (admin)",
        body: CreateBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateBody>;
      const ingredient = await svc().create({
        name: body.name,
        unit: body.unit,
        ...(body.stockMilli !== undefined ? { stockMilli: body.stockMilli } : {}),
        ...(body.lowStockMilli !== undefined ? { lowStockMilli: body.lowStockMilli } : {}),
        ...(body.costCentavosPerUnit !== undefined ? { costCentavosPerUnit: body.costCentavosPerUnit } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      });
      return reply.status(201).send({ ingredient });
    },
  );

  // ── PATCH /api/admin/ingredients/:id — update ────────────────────────────────
  app.patch(
    "/api/admin/ingredients/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Insumos — atualizar ingrediente (admin)",
        params: IdParam,
        body: UpdateBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const body = request.body as z.infer<typeof UpdateBody>;
      const ingredient = await svc().update(id, body);
      return sendRowOr404(reply, ingredient);
    },
  );

  // ── DELETE /api/admin/ingredients/:id — remove ───────────────────────────────
  app.delete(
    "/api/admin/ingredients/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Insumos — remover ingrediente (admin)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const ingredient = await svc().remove(id);
      return sendRowOr404(reply, ingredient);
    },
  );

  // ── POST /api/admin/ingredients/:id/adjust — add/subtract stock (clamp at 0) ──
  app.post(
    "/api/admin/ingredients/:id/adjust",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Insumos — ajustar estoque (add/subtract; clamp em 0) (admin)",
        params: IdParam,
        body: AdjustBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const { deltaMilli } = request.body as z.infer<typeof AdjustBody>;
      const ingredient = await svc().adjustStock(id, deltaMilli);
      return sendRowOr404(reply, ingredient);
    },
  );
}
