// ops-price-read.ts — NEW-004 shared admin catalog pricing read + snapshot.
//
// Prices live PER-VARIANT in Medusa v2, stored in the main currency unit
// (reais) — IbateXas's wire convention is INTEGER centavos (Hard Rule #2), so
// this module converts reais → centavos (× 100) on read, mirroring the admin
// products routes (routes/admin/products.ts). It reads a product's BRL variant
// prices ONCE and is consumed by THREE seams (all wired in claustrum-bootstrap):
//   - the resolver's `lookupProductPricing` (via `computeOpsPricingSnapshot`) —
//     the pricing snapshot the `product.price.set` guards + CONFIRM prompt read;
//   - the tool registry's `readProductBrlVariantIds` — the variant ids the
//     executor re-prices;
//   - the price confirm-RESUME re-projection (`enrichResumeState`).
//
// The `medusaAdmin` GET transport is INJECTED so the read is unit-testable with
// a fake (no live Medusa).

import type { OpsResolverPriceProduct } from "./ops-resolver.js";

/** The raw pricing read: product identity + its BRL-priced variants (centavos). */
export interface OpsProductPricingRead {
  readonly id: string;
  readonly status: string;
  readonly name: string;
  readonly brlVariants: ReadonlyArray<{
    readonly variantId: string;
    readonly priceCentavos: number;
  }>;
}

/** The injected admin GET transport (production: `medusaAdmin` from @ibatexas/tools). */
export type MedusaAdminGet = (path: string) => Promise<unknown>;

/**
 * Read a product's BRL variant prices from the admin catalog. Returns null when
 * the product is absent. Considers ONLY variants that carry a BRL price (a
 * variant with no BRL price is excluded from both the snapshot's uniformity
 * computation and the executor's re-price set). Medusa v2 stores amounts in
 * reais → centavos (Math.round(amount × 100)).
 */
export async function readOpsProductPricing(
  medusaAdminGet: MedusaAdminGet,
  productId: string,
): Promise<OpsProductPricingRead | null> {
  const data = (await medusaAdminGet(
    `/admin/products/${productId}?expand=variants,variants.prices`,
  )) as {
    product?: {
      id: string;
      title: string;
      status: string;
      variants?: Array<{
        id: string;
        prices?: Array<{ amount: number; currency_code: string }>;
      }>;
    };
  };
  const p = data.product;
  if (!p || typeof p.id !== "string" || p.id.length === 0) return null;
  const brlVariants: Array<{ variantId: string; priceCentavos: number }> = [];
  for (const v of p.variants ?? []) {
    const brl = (v.prices ?? []).find((pr) => pr.currency_code === "brl");
    if (brl && typeof brl.amount === "number") {
      brlVariants.push({
        variantId: v.id,
        priceCentavos: Math.round(brl.amount * 100),
      });
    }
  }
  return { id: p.id, status: p.status, name: p.title, brlVariants };
}

/**
 * Map a raw pricing read to the `OpsResolverPriceProduct` snapshot the pack
 * guards + CONFIRM prompt read: `currentPriceCentavos` = the displayed price
 * (min BRL variant price = max when uniform); `divergentVariantPrices` = TRUE
 * when the BRL variant prices are not all equal (per-variation pricing). Returns
 * null when the product is absent OR has no BRL-priced variant (⇒ fail-closed
 * REFUSE product_not_found).
 */
export function computeOpsPricingSnapshot(
  read: OpsProductPricingRead | null,
): OpsResolverPriceProduct | null {
  if (read === null || read.brlVariants.length === 0) return null;
  const prices = read.brlVariants.map((v) => v.priceCentavos);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    id: read.id,
    status: read.status,
    name: read.name,
    currentPriceCentavos: min,
    divergentVariantPrices: min !== max,
  };
}
