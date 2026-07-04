// ops-product-resolution.ts — deterministic ops-plane product name→id
// resolution (BKL-089, product scope).
//
// The ops resolver's `product.availability.set` path is id-literal v1: a payload
// `productId` that is not a real product id projects `product: null` → the
// pack-ops `requireProductExists` guard REFUSEs `product_not_found`. But the
// owner speaks NAMES ("acabou a picanha"), not Medusa ids, so the flagship verb
// is hard to use. This module resolves a free-text product reference to a
// concrete product DETERMINISTICALLY (no LLM in the path), so the ops resolver
// can rewrite the payload BEFORE adjudication — the chat-plane BKL-028/061
// precedent: enrich the payload deterministically, rebuild the envelope, and let
// the kernel's intentHash re-derivation cover the FINAL (resolved) payload.
//
// ── Read source (why the admin catalog list, not Typesense) ──────────────────
// Candidates come from the SAME first-party admin catalog list read the admin
// products surface uses (`GET /api/admin/products` → `medusaAdmin('/admin/
// products?q=...')`), injected here as `listProducts`. It is chosen over the
// Typesense `searchProducts` tool BECAUSE `searchProducts` HARD-filters to
// `status:published && inStock:true` (search-products.ts `buildFilterBy`), which
// would make the flagship RE-ENABLE case ("voltou a picanha" — the item is
// currently out-of-stock, which is WHY we re-enable it) unresolvable. The admin
// list returns products regardless of stock / publish status.
//
// ── Policy (STRICT, deterministic — never guess) ─────────────────────────────
//   - normalize both the query and every candidate title (lowercase, diacritic-
//     strip, collapse-and-trim whitespace);
//   - an EXACT normalized-title match wins (when exactly one candidate matches);
//   - else a single unique normalized SUBSTRING match wins (title ⊇ query OR
//     query ⊇ title — bidirectional, so "picanha" resolves "Picanha Fatiada"
//     and "picanha fatiada" resolves "Picanha");
//   - 0 matches OR >1 matches ⇒ NO resolution (a discriminated result the caller
//     honors: it leaves the payload untouched → honest kernel REFUSE);
//   - a lookup THROW ⇒ "none" (fail-closed), logged.

import { logger } from "../lib/logger.js";

/** A catalog candidate: id + title (for matching) + status (for the state). */
export interface ProductCandidate {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * The injected first-party catalog read. Given a free-text query it returns
 * candidate products (id + title + status) — in production the admin products
 * list read (`medusaAdmin('/admin/products?q=<query>&fields=id,title,status')`),
 * which returns products regardless of stock/publish status. A THROW is caught
 * by {@link resolveProductByName} and degrades to a "none" resolution.
 */
export type ListProductsByName = (
  query: string,
) => Promise<readonly ProductCandidate[]>;

/** A discriminated resolution outcome — the caller NEVER guesses on none/ambiguous. */
export type ProductResolution =
  | { readonly kind: "resolved"; readonly product: ProductCandidate }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly ProductCandidate[] };

/**
 * Deterministic reference normalization: NFD diacritic-strip → lowercase →
 * collapse internal whitespace runs → trim. Applied identically to the query and
 * to every candidate title so matching is diacritic- and case-insensitive
 * ("Açaí" ≡ "acai", "PICANHA " ≡ "picanha").
 */
export function normalizeProductRef(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a free-text product reference to a single product, STRICTLY and
 * DETERMINISTICALLY (see the module header for the policy). Returns a
 * discriminated {@link ProductResolution}; never throws (a lookup throw → none,
 * logged fail-closed).
 */
export async function resolveProductByName(
  query: string,
  listProducts: ListProductsByName,
): Promise<ProductResolution> {
  const q = normalizeProductRef(query);
  if (q === "") return { kind: "none" };

  let candidates: readonly ProductCandidate[];
  try {
    candidates = await listProducts(query);
  } catch (err) {
    logger.warn(
      {
        component: "ops-product-resolution",
        err: (err as Error).message,
      },
      "product name lookup failed — treating as no resolution (fail-closed)",
    );
    return { kind: "none" };
  }

  // Defensive: keep only well-formed candidates (the read is first-party but the
  // runtime shape is not guaranteed by the type system).
  const valid = candidates.filter(
    (c) =>
      typeof c.id === "string" &&
      c.id.length > 0 &&
      typeof c.title === "string",
  );

  // 1) EXACT normalized-title match.
  const exact = valid.filter((c) => normalizeProductRef(c.title) === q);
  if (exact.length === 1) return { kind: "resolved", product: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  // 2) Unique SUBSTRING match (bidirectional). A candidate whose title
  //    normalizes to empty is skipped (else `q.includes("")` matches everything).
  const substring = valid.filter((c) => {
    const t = normalizeProductRef(c.title);
    if (t === "") return false;
    return t.includes(q) || q.includes(t);
  });
  if (substring.length === 1) return { kind: "resolved", product: substring[0]! };
  if (substring.length > 1) return { kind: "ambiguous", candidates: substring };

  return { kind: "none" };
}
