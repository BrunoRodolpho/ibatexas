// sync_cart tool — BULK-add the client's local cart line items to the Medusa cart
// behind ONE governed `order.cart.sync` envelope (BKL-180).
//
// COMPOSES the existing single-item `addToCart` per line rather than re-deriving the
// Medusa egress: each line still flows through `medusaStoreAdjudicated.carts.lineItems
// .add` (the per-item egress adjudication + availability guard + ownership assert are
// preserved), while the ROUTE now proposes ONE `order.cart.sync` envelope (adjudicated
// by the pack, incl. the BKL-180 bulk-allergen validator) instead of N per-line
// `medusa.cart.*` decompositions. Allergens are a GOVERNANCE concern validated by the
// pack (requireExplicitAllergens' cart.sync branch) BEFORE this executor runs — the
// Medusa line-item add itself carries only variantId + quantity, so this executor does
// not thread allergens onward (they never reach Medusa; they gate the envelope).
//
// DUAL-EXECUTOR DIVERGENCE (BKL-180, accepted): the CHECKOUT route
// (`routes/cart.ts` `syncLocalCartForCheckout`) does NOT use this tool — it adjudicates
// the SAME `order.cart.sync` kind but runs `addLocalItemsToCart` on EXECUTE, which
// preserves `productType` metadata and does NOT re-run the availability check (an
// in-cart item must not be rejected at checkout). This registered tool (the general /
// non-checkout executor for the kind) DOES run availability via `addToCart` and drops
// `productType`. The two cannot share code across the packages/tools ↔ apps/api
// boundary; keep them consciously in sync (see the reciprocal note on
// `addLocalItemsToCart`).

import { z } from "zod";
import type { AgentContext } from "@ibatexas/types";
import { addToCart } from "./add-to-cart.js";

export const SyncCartInputSchema = z.object({
  cartId: z.string().min(1),
  items: z.array(
    z.object({
      variantId: z.string().min(1),
      quantity: z.number().int().min(1).max(99),
    }),
  ),
});

export type SyncCartInput = z.infer<typeof SyncCartInputSchema>;

/** One line's add outcome (the shape `addToCart` returns; opaque to callers). */
export interface SyncCartResult {
  readonly success: boolean;
  readonly syncedItemCount: number;
  readonly results: readonly unknown[];
}

/**
 * Add EVERY item in `input.items` to the cart, in order, via `addToCart`. Ownership +
 * availability + the per-item egress adjudication are enforced inside `addToCart`; a
 * per-line failure surfaces in `results` (never swallowed) exactly as the pre-wire
 * per-line replay did. Idempotent w.r.t. the caller's edge-handling (a fresh cart is
 * chosen upstream in `syncLocalCartForCheckout` before this runs).
 */
export async function syncCart(
  input: SyncCartInput,
  ctx: AgentContext,
): Promise<SyncCartResult> {
  const parsed = SyncCartInputSchema.parse(input);
  const results: unknown[] = [];
  for (const item of parsed.items) {
    results.push(
      await addToCart(
        { cartId: parsed.cartId, variantId: item.variantId, quantity: item.quantity },
        ctx,
      ),
    );
  }
  return { success: true, syncedItemCount: parsed.items.length, results };
}
