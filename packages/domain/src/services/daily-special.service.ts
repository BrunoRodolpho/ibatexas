// DailySpecialService — the NEW-005 daily-specials / promo-of-the-day slice (ADMIN
// AUTHORING). A Daily Special = a Medusa finished-good FEATURED for one restaurant
// business-day, optionally at a promo price with a pt-BR headline.
//
// Plain CRUD (mirrors ingredient.service.ts / recipe.service.ts) — daily specials are
// admin-ops authored config/reference, NOT a customer money/safety path, so they do
// NOT go through the adjudicate kernel; the manager-gate lives at the route
// (requireManagerRole). Scope: create + list (by date / active) + getForDate (the
// menu read) + update + remove. The customer-facing menu/web + chat surfacing (rides
// grounding/claims — the harder half) is DEFERRED to NEW-038.
//
// MONEY (`promoPriceCentavos`) is INTEGER CENTAVOS (Hard-Rule #2) — never a float; NULL
// = featured without a discount. `date` is a business-day LABEL (YYYY-MM-DD) resolved
// in RESTAURANT_TIMEZONE at the route — a String, not a DateTime.
//
// update / remove are ROW-OR-NULL (mirror ingredient.service): a findUnique existence
// check, then updateMany / deleteMany, so a missing id is `null` (the route 404s)
// rather than a P2025 throw. `null` also covers the row VANISHING between those two
// statements — update honors updateMany's `{count}` (BKL-265).

import { prisma } from "../client.js"
// TYPE-ONLY import (erased at runtime) — safe in this index-eagerly-loaded service;
// the "no value-import" rule is about runtime imports, and this pulls in no runtime.
import type { DailySpecial } from "../generated/prisma-client/client.js"

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for creating a daily special. */
export interface CreateDailySpecialInput {
  readonly medusaProductId: string
  /** Business-day label YYYY-MM-DD (resolved in RESTAURANT_TIMEZONE; validated at the route). */
  readonly date: string
  /** Promo price in INTEGER CENTAVOS. Omitted/null → featured without a discount. */
  readonly promoPriceCentavos?: number | null
  /** Optional pt-BR promo blurb. Omitted/null → no headline. */
  readonly headline?: string | null
  readonly active?: boolean
}

/** Partial patch for an existing daily special — every field optional. */
export interface UpdateDailySpecialPatch {
  readonly medusaProductId?: string
  readonly date?: string
  /** Explicit `null` CLEARS the promo price (back to "no discount"); omitted leaves it untouched. */
  readonly promoPriceCentavos?: number | null
  /** Explicit `null` CLEARS the headline; omitted leaves it untouched. */
  readonly headline?: string | null
  readonly active?: boolean
}

/** Params for listing daily specials. */
export interface ListDailySpecialsParams {
  /** When set, return only specials for this business-day (YYYY-MM-DD). */
  readonly date?: string
  /** When true, return only active specials; otherwise return all. */
  readonly activeOnly?: boolean
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createDailySpecialService() {
  /**
   * ROW-OR-NULL mutate: existence check + updateMany with the patch `compute` returns
   * for the loaded row. A missing id is `null` (no throw). Merges the patch onto the
   * loaded row for the return (same idiom as ingredient.service — the return reflects
   * the write without a second round-trip).
   *
   * BKL-265 — the WRITE's `count` is authoritative, not the read's. A row deleted
   * between the findUnique and the updateMany matches nothing, and the merged object
   * would then report a patch no row carries (`executeMenuSpecialSet` renders success
   * off a truthy specialId). `count === 0` is therefore `null`, same as a missing id.
   * Both models carry `@updatedAt`, so Prisma always writes a column and an empty
   * patch still counts the matched row.
   */
  async function mutateOrNull(
    id: string,
    compute: (existing: DailySpecial) => UpdateDailySpecialPatch,
  ) {
    const existing = await prisma.dailySpecial.findUnique({ where: { id } })
    if (!existing) return null
    const patch = compute(existing)
    const { count } = await prisma.dailySpecial.updateMany({ where: { id }, data: patch })
    if (count === 0) return null
    return { ...existing, ...patch }
  }

  return {
    /** Create a daily special. Omitted promoPrice/headline/active fall to the DB defaults. */
    async create(input: CreateDailySpecialInput) {
      return prisma.dailySpecial.create({
        data: {
          medusaProductId: input.medusaProductId,
          date: input.date,
          ...(input.promoPriceCentavos !== undefined ? { promoPriceCentavos: input.promoPriceCentavos } : {}),
          ...(input.headline !== undefined ? { headline: input.headline } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      })
    },

    /**
     * Patch an existing daily special. Only the DEFINED fields of `patch` are written
     * (an omitted field is left untouched — never overwritten). An explicit `null` on
     * promoPriceCentavos / headline is a DEFINED value → clears it. Row-or-null: returns
     * `null` when no special with that id exists — or when the row vanished before the
     * write landed (BKL-265).
     */
    async update(id: string, patch: UpdateDailySpecialPatch) {
      // Strip undefined so an omitted field is left untouched (not nulled); an explicit
      // `null` is a DEFINED value here → writes null (clears the field).
      const data: UpdateDailySpecialPatch = {
        ...(patch.medusaProductId !== undefined ? { medusaProductId: patch.medusaProductId } : {}),
        ...(patch.date !== undefined ? { date: patch.date } : {}),
        ...(patch.promoPriceCentavos !== undefined ? { promoPriceCentavos: patch.promoPriceCentavos } : {}),
        ...(patch.headline !== undefined ? { headline: patch.headline } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      }
      return mutateOrNull(id, () => data)
    },

    /**
     * List daily specials, optionally filtered by `date` and/or active-only. Ordered by
     * date DESC (most recent day first) then createdAt ASC (authoring order within a day).
     */
    async list(params: ListDailySpecialsParams = {}) {
      return prisma.dailySpecial.findMany({
        where: {
          ...(params.date !== undefined ? { date: params.date } : {}),
          ...(params.activeOnly ? { active: true } : {}),
        },
        orderBy: [{ date: "desc" }, { createdAt: "asc" }],
      })
    },

    /**
     * The menu read: ACTIVE specials for one business-day (YYYY-MM-DD), in authoring
     * order (createdAt ASC). Backs GET /today. The customer-facing surfacing of this
     * read is DEFERRED to NEW-038.
     */
    async getForDate(date: string) {
      return prisma.dailySpecial.findMany({
        where: { date, active: true },
        orderBy: { createdAt: "asc" },
      })
    },

    /**
     * Delete a daily special by id. Returns the deleted row, or `null` when no row with
     * that id exists (idempotent — findUnique existence check, then deleteMany so a
     * missing id is a count of 0, not a P2025 throw; the route 404s on null).
     */
    async remove(id: string) {
      const existing = await prisma.dailySpecial.findUnique({ where: { id } })
      if (!existing) return null
      await prisma.dailySpecial.deleteMany({ where: { id } })
      return existing
    },
  }
}

export type DailySpecialService = ReturnType<typeof createDailySpecialService>
