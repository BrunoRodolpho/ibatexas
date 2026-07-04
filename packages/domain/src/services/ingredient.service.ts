// IngredientService — the NEW-003 stock slice: track raw-ingredient stock and
// raise a low-stock read.
//
// Plain CRUD (mirrors table.service.ts / delivery-zone.service.ts / staff-
// schedule.service.ts) — raw-ingredient inventory is admin-ops, NOT a customer
// money/safety path, so it does NOT go through the adjudicate kernel; the
// manager-gate lives at the route (requireManagerRole). Scope is deliberately
// narrow: CRUD + adjustStock + listLowStock. NEW-035 adds a per-unit COST field
// (costCentavosPerUnit) so an ingredient can feed a recipe's COGS read; the
// recipe/BOM + COGS math live in recipe.service.ts. Per-dish depletion (the
// order.placed subscriber) is OUT of scope (deferred).
//
// QUANTITIES are SCALED INTEGERS in THOUSANDTHS of the unit (milli-units): 2.5 kg
// → 2500. Arithmetic (adjustStock) is integer-precise — never a float.
//
// update / remove / adjustStock are ROW-OR-NULL (mirror staff-schedule's
// deleteShift / stampClock): a findUnique existence check, then updateMany /
// deleteMany, so a missing id is `null` (the route 404s) rather than a P2025 throw.

import { prisma } from "../client.js"
// TYPE-ONLY import (erased at runtime) — safe in this index-eagerly-loaded service;
// the "no value-import" rule is about runtime imports, and this pulls in no runtime.
import type { Ingredient } from "../generated/prisma-client/client.js"

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for creating an ingredient. Quantities are milli-units; both default to 0. */
export interface CreateIngredientInput {
  readonly name: string
  readonly unit: string
  readonly stockMilli?: number
  readonly lowStockMilli?: number
  /** NEW-035 — per-unit purchase cost in INTEGER CENTAVOS (of one whole `unit`).
   *  Omitted/null → no cost set (excluded from COGS, never guessed). */
  readonly costCentavosPerUnit?: number | null
  readonly active?: boolean
}

/** Partial patch for an existing ingredient — every field optional. */
export interface UpdateIngredientPatch {
  readonly name?: string
  readonly unit?: string
  readonly stockMilli?: number
  readonly lowStockMilli?: number
  /** NEW-035 — per-unit cost in centavos. Explicit `null` CLEARS the cost (back to
   *  "no cost set"); omitted leaves it untouched. */
  readonly costCentavosPerUnit?: number | null
  readonly active?: boolean
}

/** Params for listing ingredients. */
export interface ListIngredientsParams {
  /** When true, return only active ingredients; otherwise return all. */
  readonly activeOnly?: boolean
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createIngredientService() {
  /**
   * ROW-OR-NULL mutate: existence check + updateMany with the patch `compute`
   * returns for the loaded row. A missing id is `null` (no throw). Shared by
   * update + adjustStock so the two differ only in which patch they compute
   * (mirrors staff-schedule's stampClock). Merges the patch onto the loaded row
   * for the return (same idiom as deleteShift/stampClock — the return reflects the
   * write without a second round-trip).
   */
  async function mutateOrNull(
    id: string,
    compute: (existing: Ingredient) => UpdateIngredientPatch,
  ) {
    const existing = await prisma.ingredient.findUnique({ where: { id } })
    if (!existing) return null
    const patch = compute(existing)
    await prisma.ingredient.updateMany({ where: { id }, data: patch })
    return { ...existing, ...patch }
  }

  return {
    /** Create an ingredient. Quantities default to 0 milli-units when omitted. */
    async create(input: CreateIngredientInput) {
      return prisma.ingredient.create({
        data: {
          name: input.name,
          unit: input.unit,
          stockMilli: input.stockMilli ?? 0,
          lowStockMilli: input.lowStockMilli ?? 0,
          ...(input.costCentavosPerUnit !== undefined ? { costCentavosPerUnit: input.costCentavosPerUnit } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      })
    },

    /**
     * Patch an existing ingredient. Only the DEFINED fields of `patch` are written
     * (an omitted field is left untouched — never overwritten with a default).
     * Row-or-null: returns `null` when no ingredient with that id exists.
     */
    async update(id: string, patch: UpdateIngredientPatch) {
      // Strip undefined so an omitted field is left untouched (not nulled).
      const data: UpdateIngredientPatch = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
        ...(patch.stockMilli !== undefined ? { stockMilli: patch.stockMilli } : {}),
        ...(patch.lowStockMilli !== undefined ? { lowStockMilli: patch.lowStockMilli } : {}),
        // `null` is a DEFINED value here → writes null (clears the cost); only an
        // omitted (undefined) field is left untouched.
        ...(patch.costCentavosPerUnit !== undefined ? { costCentavosPerUnit: patch.costCentavosPerUnit } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      return mutateOrNull(id, () => data)
    },

    /** List ingredients (all, or only active), ordered by name. */
    async list(params: ListIngredientsParams = {}) {
      return prisma.ingredient.findMany({
        where: params.activeOnly ? { active: true } : {},
        orderBy: { name: "asc" },
      })
    },

    /**
     * Delete an ingredient by id. Returns the deleted row, or `null` when no row
     * with that id exists (idempotent — deleteMany so a missing id is a count of 0,
     * not a P2025 throw; the route 404s on null).
     */
    async remove(id: string) {
      const existing = await prisma.ingredient.findUnique({ where: { id } })
      if (!existing) return null
      await prisma.ingredient.deleteMany({ where: { id } })
      return existing
    },

    /**
     * Add (or subtract, with a negative delta) `deltaMilli` milli-units of stock.
     * CLAMPED at 0 — stock never goes negative. Row-or-null: returns `null` when no
     * ingredient with that id exists. Integer arithmetic — precise.
     */
    async adjustStock(id: string, deltaMilli: number) {
      return mutateOrNull(id, (existing) => ({
        stockMilli: Math.max(0, existing.stockMilli + deltaMilli),
      }))
    },

    /**
     * List active ingredients at or below their low-stock threshold
     * (`stockMilli <= lowStockMilli`). A two-column compare, so we fetch the active
     * ingredients (a bounded set) and filter in JS — sound + simple. Ordered by name.
     */
    async listLowStock() {
      const active = await prisma.ingredient.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
      })
      return active.filter((i) => i.stockMilli <= i.lowStockMilli)
    },
  }
}

export type IngredientService = ReturnType<typeof createIngredientService>
