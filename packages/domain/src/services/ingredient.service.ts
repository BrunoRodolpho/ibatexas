// IngredientService — the NEW-003 stock slice: track raw-ingredient stock and
// raise a low-stock read.
//
// Plain CRUD (mirrors table.service.ts / delivery-zone.service.ts / staff-
// schedule.service.ts) — raw-ingredient inventory is admin-ops, NOT a customer
// money/safety path, so it does NOT go through the adjudicate kernel; the
// manager-gate lives at the route (requireManagerRole). Scope: CRUD + adjustStock
// + listLowStock + depleteStock. NEW-035 adds a per-unit COST field
// (costCentavosPerUnit) so an ingredient can feed a recipe's COGS read; the
// recipe/BOM + COGS math live in recipe.service.ts. NEW-036 adds `depleteStock`
// — the consume-with-shortfall-signal primitive the order.placed depletion
// subscriber (in apps/api) calls DIRECTLY (non-kernel: stock is admin-ops, not a
// customer money/safety path). The subscriber itself lives outside the domain.
//
// QUANTITIES are SCALED INTEGERS in THOUSANDTHS of the unit (milli-units): 2.5 kg
// → 2500. Arithmetic (adjustStock) is integer-precise — never a float.
//
// update / remove / adjustStock are ROW-OR-NULL (mirror staff-schedule's
// deleteShift / stampClock): a findUnique existence check, then updateMany /
// deleteMany, so a missing id is `null` (the route 404s) rather than a P2025 throw.
// `null` also covers the row VANISHING between those two statements — the mutating
// paths honor updateMany's `{count}` (BKL-265).

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

/**
 * NEW-036 — result of {@link IngredientService.depleteStock}: the clamped
 * ingredient row plus `shortfallMilli`, the milli-units by which the requested
 * consume exceeded on-hand stock. `shortfallMilli` is 0 when stock covered the
 * consume; `> 0` means the write clamped `stockMilli` at 0 (the under-stock signal
 * the depletion subscriber warns on — stock accuracy issue).
 */
export interface DepleteStockResult extends Ingredient {
  readonly shortfallMilli: number
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
   *
   * BKL-265 — the WRITE's `count` is authoritative, not the read's. A row deleted
   * between the findUnique and the updateMany matches nothing, and the merged
   * object would then report a stock level no row carries (depleteStock's caller
   * warns off `shortfallMilli`). `count === 0` is therefore `null`, same as a
   * missing id. The model carries `@updatedAt`, so Prisma always writes a column
   * and an empty patch still counts the matched row.
   */
  async function mutateOrNull(
    id: string,
    compute: (existing: Ingredient) => UpdateIngredientPatch,
  ) {
    const existing = await prisma.ingredient.findUnique({ where: { id } })
    if (!existing) return null
    const patch = compute(existing)
    const { count } = await prisma.ingredient.updateMany({ where: { id }, data: patch })
    if (count === 0) return null
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
     * Row-or-null: returns `null` when no ingredient with that id exists, or when
     * the row vanished before the write landed (BKL-265).
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
     * ingredient with that id exists, or when the row vanished before the write
     * landed (BKL-265). Integer arithmetic — precise.
     */
    async adjustStock(id: string, deltaMilli: number) {
      return mutateOrNull(id, (existing) => ({
        stockMilli: Math.max(0, existing.stockMilli + deltaMilli),
      }))
    },

    /**
     * NEW-036 — CONSUME `amountMilli` (≥ 0) milli-units of stock: the purpose-built
     * order-flow depletion primitive. Distinct from adjustStock (a SIGNED manual
     * admin correction) — depleteStock takes an unsigned quantity-to-consume and
     * also reports the SHORTFALL. From the ONE loaded row (via mutateOrNull — no
     * second read) it:
     *   • writes `stockMilli = Math.max(0, existing.stockMilli - amountMilli)` —
     *     CLAMPED at 0, stock never goes negative;
     *   • computes `shortfallMilli = Math.max(0, amountMilli - existing.stockMilli)`
     *     — how much MORE was needed than on hand (0 when covered; `> 0` = the
     *     write clamped, i.e. stock went below what the order required).
     * Row-or-null: `null` when no ingredient with that id exists (mirrors
     * adjustStock's existence check) or when the row vanished before the write
     * landed (BKL-265) — in both cases NOTHING was depleted, so no `shortfallMilli`
     * is reported. Integer arithmetic — precise. Returns the clamped row merged with
     * `shortfallMilli`, or `null`.
     */
    async depleteStock(id: string, amountMilli: number): Promise<DepleteStockResult | null> {
      let shortfallMilli = 0
      const row = await mutateOrNull(id, (existing) => {
        shortfallMilli = Math.max(0, amountMilli - existing.stockMilli)
        return { stockMilli: Math.max(0, existing.stockMilli - amountMilli) }
      })
      return row === null ? null : { ...row, shortfallMilli }
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
