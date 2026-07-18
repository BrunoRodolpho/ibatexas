// live/backfill-lineitem-ids-input.ts — the PURE planning half of the BKL-167
// line-item-id backfill. Given the order_projections rows a sweep fetched, it
// deterministically classifies which need the stable Medusa line-item id
// (`OrderEventItem.id`, threaded through the projection since FE-D15 / PR #295)
// re-derived onto their `itemsJson`, and which are already complete.
//
// FE-D15 threaded `OrderEventItem.id` ADDITIVELY: only orders projected AFTER #295
// carry it. Pre-FE-D15 rows have `itemsJson` entries with no `id`, so the admin
// plane falls back to a synthetic `variantId`/index id (routes/admin/orders.ts
// mapProjectionItems). This backfill re-fetches each such order from Medusa (the
// source of truth) and rewrites its `itemsJson` via the SAME `toOrderProjectionData`
// mapper production order-sync uses, so the ids become byte-consistent with Medusa.
//
// PURE + self-contained (SDD §Q scope guard): no clock / RNG / IO, no prisma / tools
// import (a unit test of this module loads NO prisma client — the seed-input.ts
// idiom). The live executor (backfill-lineitem-ids.ts) does the Medusa fetch + the
// raw prisma write off THIS plan.

/** Default per-run sweep bound (rows fetched + classified). Sane + overridable via
 *  `--limit`; a larger backlog is handled by re-running (idempotent) or raising it. */
export const DEFAULT_BACKFILL_LIMIT = 200;

/**
 * Does a single `itemsJson` entry already carry a stable, non-empty line-item id?
 * (The FE-D15 additive `OrderEventItem.id`.) A pre-FE-D15 entry has no `id` key.
 * Pure.
 */
export function itemHasStableId(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

/** The sweep disposition of one projection row's `itemsJson` (pure). */
export type BackfillDisposition = "needs-backfill" | "already-complete" | "no-items";

/**
 * Classify a projection row's `itemsJson` for the backfill:
 *   - `no-items`         — empty / non-array → nothing to backfill (skip).
 *   - `already-complete` — EVERY entry already carries a stable id → skip
 *     (the idempotency guard: a re-run touches nothing once backfilled).
 *   - `needs-backfill`   — ≥1 entry lacks a stable id → re-derive from Medusa.
 * Pure.
 */
export function classifyItemsJson(itemsJson: unknown): BackfillDisposition {
  if (!Array.isArray(itemsJson) || itemsJson.length === 0) return "no-items";
  return itemsJson.every(itemHasStableId) ? "already-complete" : "needs-backfill";
}

/** The minimal projection-row shape the pure planner reads (id + its itemsJson). */
export interface BackfillCandidateRow {
  readonly id: string;
  readonly itemsJson: unknown;
}

/**
 * The deterministic sweep plan over the fetched rows: which order ids need a
 * Medusa re-derivation, and which are skipped (already complete / no items).
 * Order-stable over the input row order. Pure.
 */
export interface BackfillPlan {
  /** Order ids whose itemsJson has ≥1 entry missing a stable id — to re-derive. */
  readonly toBackfill: readonly string[];
  /** Order ids skipped because every entry already carries a stable id. */
  readonly alreadyComplete: readonly string[];
  /** Order ids skipped because itemsJson is empty / non-array (nothing to id). */
  readonly noItems: readonly string[];
}

/** Build the deterministic {@link BackfillPlan} from the fetched rows. Pure. */
export function buildBackfillPlan(rows: readonly BackfillCandidateRow[]): BackfillPlan {
  const toBackfill: string[] = [];
  const alreadyComplete: string[] = [];
  const noItems: string[] = [];
  for (const row of rows) {
    switch (classifyItemsJson(row.itemsJson)) {
      case "needs-backfill":
        toBackfill.push(row.id);
        break;
      case "already-complete":
        alreadyComplete.push(row.id);
        break;
      case "no-items":
        noItems.push(row.id);
        break;
    }
  }
  return { toBackfill, alreadyComplete, noItems };
}
