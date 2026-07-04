// admin/recipes.ts — the NEW-035 recipe/BOM + per-dish COGS surface (extends the
// NEW-003 ingredient inventory). Manager-gated REST over RecipeService: CRUD over a
// recipe (a Medusa finished-good's bill-of-materials), a set-BOM-lines write, and a
// COGS (cost-of-goods-sold) read.
//
//   GET    /api/admin/recipes                  → { recipes }
//   GET    /api/admin/recipes/:id              → { recipe, cogs } | 404
//   POST   /api/admin/recipes                  → 201 { recipe }
//   PUT    /api/admin/recipes/:id/ingredients  → { recipe } | 404   (body: { lines })
//   DELETE /api/admin/recipes/:id              → { recipe } | 404
//   GET    /api/admin/recipes/:id/cogs         → { cogs } | 404
//
// Mirrors admin/ingredients.ts: `withTypeProvider`, zod schemas, a lazily-constructed
// service (so a test mounting the plugin with a partial `@ibatexas/domain` mock
// doesn't trip over a missing factory at register time), and a `requireManagerRole`
// preHandler that fail-closes to 403.
//
// Plain CRUD (NOT kernel-adjudicated): recipes are admin-ops reference/config, not a
// customer money/safety path — the manager-gate IS the authority (mirrors ingredients
// / tables). QUANTITIES are SCALED INTEGERS in milli-units (thousandths of the
// ingredient's unit): 2.5 kg → 2500. COGS is INTEGER CENTAVOS. The order-flow
// depletion subscriber (consume ingredients on order.placed) is DEFERRED — not here.

import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createRecipeService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";

const IdParam = z.object({ id: z.string().min(1).max(256) });

// One BOM line: consume a positive milli-unit quantity of an ingredient per batch.
const Line = z.object({
  ingredientId: z.string().min(1).max(256),
  qtyMilli: z.number().int().positive(),
});

const CreateBody = z.object({
  medusaProductId: z.string().min(1).max(256),
  yield: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
  lines: z.array(Line).optional(),
});

// Replace-the-BOM body — an empty array clears the recipe's lines.
const SetIngredientsBody = z.object({ lines: z.array(Line) });

export async function recipeRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting this
  // plugin with a partial `@ibatexas/domain` mock doesn't trip over a missing
  // factory at register time (mirrors ingredients.ts / schedule-shifts.ts).
  let recipeSvc: ReturnType<typeof createRecipeService> | undefined;
  const svc = () => (recipeSvc ??= createRecipeService());

  // Shared 404 tail (DRY — every row-or-null handler below reuses it).
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: "recipe_not_found" });

  // ── GET /api/admin/recipes — list recipes (each with its BOM lines) ──────────
  app.get(
    "/api/admin/recipes",
    {
      preHandler: [requireManagerRole],
      schema: { tags: ["admin"], summary: "Fichas técnicas — listar receitas (admin)" },
    },
    async (_request, reply) => {
      const recipes = await svc().list();
      return reply.send({ recipes });
    },
  );

  // ── POST /api/admin/recipes — create (header + optional initial BOM lines) ───
  app.post(
    "/api/admin/recipes",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fichas técnicas — criar receita (admin)",
        body: CreateBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateBody>;
      const recipe = await svc().create({
        medusaProductId: body.medusaProductId,
        ...(body.yield !== undefined ? { yield: body.yield } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.lines !== undefined ? { lines: body.lines } : {}),
      });
      return reply.status(201).send({ recipe });
    },
  );

  // ── GET /api/admin/recipes/:id — one recipe + its COGS ───────────────────────
  app.get(
    "/api/admin/recipes/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fichas técnicas — obter receita + COGS (admin)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const [recipe, cogs] = await Promise.all([svc().get(id), svc().getCogs(id)]);
      if (!recipe) return notFound(reply);
      return reply.send({ recipe, cogs });
    },
  );

  // ── GET /api/admin/recipes/:id/cogs — COGS read (per-batch + per-serving) ────
  app.get(
    "/api/admin/recipes/:id/cogs",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fichas técnicas — COGS da receita (admin)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const cogs = await svc().getCogs(id);
      if (!cogs) return notFound(reply);
      return reply.send({ cogs });
    },
  );

  // ── PUT /api/admin/recipes/:id/ingredients — replace the BOM lines ───────────
  app.put(
    "/api/admin/recipes/:id/ingredients",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fichas técnicas — definir insumos da receita (admin)",
        params: IdParam,
        body: SetIngredientsBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const { lines } = request.body as z.infer<typeof SetIngredientsBody>;
      const recipe = await svc().setIngredients(id, lines);
      if (!recipe) return notFound(reply);
      return reply.send({ recipe });
    },
  );

  // ── DELETE /api/admin/recipes/:id — remove (cascade-deletes its BOM lines) ───
  app.delete(
    "/api/admin/recipes/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Fichas técnicas — remover receita (admin)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof IdParam>;
      const recipe = await svc().remove(id);
      if (!recipe) return notFound(reply);
      return reply.send({ recipe });
    },
  );
}
