// RecipeService — NEW-035 recipe/BOM + per-dish COGS (extends NEW-003). A Recipe is
// the bill-of-materials for one Medusa finished-good: the raw ingredients + per-batch
// quantities that go into it. Unblocks per-dish COGS → margins (NEW-033).
//
// Plain CRUD (mirrors ingredient.service.ts / table.service.ts) — recipes are
// admin-ops reference/config, NOT a customer money/safety path, so they do NOT go
// through the adjudicate kernel; the manager-gate lives at the route. Scope: create
// (recipe + its lines), get / getByProduct / list (recipe + lines), setIngredients
// (replace the BOM), remove, and getCogs (the margin read). The order-flow depletion
// subscriber (consume ingredients on order.placed) is DEFERRED — out of this slice.
//
// QUANTITIES are SCALED INTEGERS in THOUSANDTHS of the ingredient's unit (milli-
// units): 2.5 kg → 2500 (same idiom as Ingredient.stockMilli). MONEY is INTEGER
// CENTAVOS (Hard-Rule #2) — never a float; see getCogs for the single-round rule.
//
// get / setIngredients / remove are ROW-OR-NULL (mirror ingredient.service): a
// findUnique existence check first, so a missing id is `null` (the route 404s)
// rather than a P2025 throw.

import { prisma } from "../client.js"
// TYPE-ONLY imports (erased at runtime) — safe in this index-eagerly-loaded service;
// the "no value-import" rule is about runtime imports, and these pull in no runtime.
import type { Prisma, Recipe, RecipeIngredient, Ingredient } from "../generated/prisma-client/client.js"

// ── Types ─────────────────────────────────────────────────────────────────────

/** One bill-of-materials line: `qtyMilli` of an ingredient per batch (milli-units). */
export interface RecipeLineInput {
  readonly ingredientId: string
  readonly qtyMilli: number
}

/** Input for creating a recipe (header + optional initial BOM lines). */
export interface CreateRecipeInput {
  readonly medusaProductId: string
  /** Servings/units one batch yields (per-serving COGS divisor). Defaults to 1. */
  readonly yield?: number
  readonly active?: boolean
  /** Initial BOM lines. Omitted → an empty recipe (lines set later via setIngredients). */
  readonly lines?: readonly RecipeLineInput[]
}

/** A recipe row with its BOM lines, each carrying its joined ingredient. */
export type RecipeWithLines = Recipe & {
  ingredients: (RecipeIngredient & { ingredient: Ingredient })[]
}

/** One line of a COGS breakdown. `lineCostCentavos` is 0 when `costMissing`. */
export interface CogsLine {
  readonly ingredientId: string
  readonly name: string
  readonly qtyMilli: number
  /** Integer centavos: Math.round(qtyMilli / 1000 × ingredient.costCentavosPerUnit). */
  readonly lineCostCentavos: number
  /** True when the ingredient has no unit cost set — line contributes 0, never guessed. */
  readonly costMissing: boolean
}

/** A recipe's cost-of-goods-sold read: per-batch + per-serving, with a per-line breakdown. */
export interface RecipeCogs {
  readonly recipeId: string
  readonly medusaProductId: string
  readonly yield: number
  /** Σ of the line costs (integer centavos). */
  readonly batchCogsCentavos: number
  /** Math.round(batchCogsCentavos / yield) (integer centavos). */
  readonly perServingCogsCentavos: number
  readonly lines: readonly CogsLine[]
  /** True when ANY line's ingredient has no cost set (COGS is a lower bound). */
  readonly anyCostMissing: boolean
}

// ── COGS math ───────────────────────────────────────────────────────────────

/**
 * Pure COGS computation over a loaded recipe-with-lines. Exported so the math is
 * unit-testable without a DB.
 *
 * MONEY = INTEGER CENTAVOS, rounded exactly ONCE per distinct output (never a stored
 * float, never a double-round):
 *  - `lineCostCentavos` = Math.round(qtyMilli / 1000 × costCentavosPerUnit). qtyMilli
 *    is milli-units (÷1000 → whole units), × the per-unit cost → centavos; the one
 *    float product is rounded once here.
 *  - `batchCogsCentavos` = Σ of the already-integer line costs — an EXACT integer sum
 *    (no second round), so the reported line costs always add up to the batch total.
 *  - `perServingCogsCentavos` = Math.round(batchCogsCentavos / yield) — rounded once.
 *
 * A line whose ingredient has a NULL cost is FLAGGED (`costMissing: true`), contributes
 * 0, and sets `anyCostMissing` — COGS is a lower bound, never a guessed value.
 */
export function computeRecipeCogs(recipe: RecipeWithLines): RecipeCogs {
  const lines: CogsLine[] = recipe.ingredients.map((line) => {
    const cost = line.ingredient.costCentavosPerUnit
    const costMissing = cost === null || cost === undefined
    // Round each line's money exactly once (float product → integer centavos).
    const lineCostCentavos = costMissing ? 0 : Math.round((line.qtyMilli / 1000) * cost!)
    return {
      ingredientId: line.ingredientId,
      name: line.ingredient.name,
      qtyMilli: line.qtyMilli,
      lineCostCentavos,
      costMissing,
    }
  })

  // Exact integer sum of the already-rounded line costs (no second round).
  const batchCogsCentavos = lines.reduce((sum, l) => sum + l.lineCostCentavos, 0)
  // Guard a non-positive yield (schema default 1, route enforces ≥1) against ÷0.
  const servings = recipe.yield >= 1 ? recipe.yield : 1
  const perServingCogsCentavos = Math.round(batchCogsCentavos / servings)

  return {
    recipeId: recipe.id,
    medusaProductId: recipe.medusaProductId,
    yield: recipe.yield,
    batchCogsCentavos,
    perServingCogsCentavos,
    lines,
    anyCostMissing: lines.some((l) => l.costMissing),
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

// Shared include: BOM lines with their joined ingredient, ordered by ingredient
// name for a deterministic, display-friendly line order (DRY — one shape reused by
// every recipe read + the post-write reloads).
const RECIPE_INCLUDE = {
  ingredients: {
    include: { ingredient: true },
    orderBy: { ingredient: { name: "asc" } },
  },
} satisfies Prisma.RecipeInclude

export function createRecipeService() {
  /** Load one recipe-with-lines by any unique key (DRY loader for get/getByProduct/reloads). */
  function loadRecipe(where: Prisma.RecipeWhereUniqueInput): Promise<RecipeWithLines | null> {
    return prisma.recipe.findUnique({ where, include: RECIPE_INCLUDE }) as Promise<RecipeWithLines | null>
  }

  return {
    /**
     * Create a recipe (header + optional initial BOM lines). `yield` defaults to 1,
     * `active` to the DB default when omitted. Nested-creates the lines in one write;
     * returns the recipe with its lines.
     */
    async create(input: CreateRecipeInput): Promise<RecipeWithLines> {
      const created = await prisma.recipe.create({
        data: {
          medusaProductId: input.medusaProductId,
          ...(input.yield !== undefined ? { yield: input.yield } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.lines && input.lines.length > 0
            ? { ingredients: { create: input.lines.map((l) => ({ ingredientId: l.ingredientId, qtyMilli: l.qtyMilli })) } }
            : {}),
        },
        include: RECIPE_INCLUDE,
      })
      return created as RecipeWithLines
    },

    /** Get a recipe (with lines) by id. Row-or-null when no such recipe. */
    get(id: string): Promise<RecipeWithLines | null> {
      return loadRecipe({ id })
    },

    /** Get the recipe (with lines) for a Medusa finished-good. Row-or-null. */
    getByProduct(medusaProductId: string): Promise<RecipeWithLines | null> {
      return loadRecipe({ medusaProductId })
    },

    /** List all recipes (each with its lines), most-recent first. */
    list(): Promise<RecipeWithLines[]> {
      return prisma.recipe.findMany({
        include: RECIPE_INCLUDE,
        orderBy: { createdAt: "desc" },
      }) as Promise<RecipeWithLines[]>
    },

    /**
     * REPLACE a recipe's BOM lines with `lines` (delete-all-then-recreate, in a
     * transaction so a reader never sees a half-swapped BOM). Row-or-null: returns
     * `null` when no recipe with that id exists (the route 404s) — the existence
     * check runs inside the transaction. Returns the recipe with its new lines.
     */
    async setIngredients(recipeId: string, lines: readonly RecipeLineInput[]): Promise<RecipeWithLines | null> {
      return prisma.$transaction(async (tx) => {
        const existing = await tx.recipe.findUnique({ where: { id: recipeId } })
        if (!existing) return null
        await tx.recipeIngredient.deleteMany({ where: { recipeId } })
        if (lines.length > 0) {
          await tx.recipeIngredient.createMany({
            data: lines.map((l) => ({ recipeId, ingredientId: l.ingredientId, qtyMilli: l.qtyMilli })),
          })
        }
        return tx.recipe.findUnique({ where: { id: recipeId }, include: RECIPE_INCLUDE }) as Promise<RecipeWithLines>
      })
    },

    /**
     * Delete a recipe by id. Its BOM lines are removed by the FK ON DELETE CASCADE.
     * Returns the deleted recipe (with lines), or `null` when no row exists
     * (idempotent — findUnique existence check, then deleteMany; the route 404s on null).
     */
    async remove(id: string): Promise<RecipeWithLines | null> {
      const existing = await loadRecipe({ id })
      if (!existing) return null
      await prisma.recipe.deleteMany({ where: { id } })
      return existing
    },

    /**
     * COGS for a recipe: per-batch + per-serving cost, with a per-line breakdown.
     * Row-or-null when no recipe with that id exists. See computeRecipeCogs for the
     * integer-centavos, round-once, null-cost-flagged math.
     */
    async getCogs(recipeId: string): Promise<RecipeCogs | null> {
      const recipe = await loadRecipe({ id: recipeId })
      if (!recipe) return null
      return computeRecipeCogs(recipe)
    },
  }
}

export type RecipeService = ReturnType<typeof createRecipeService>
