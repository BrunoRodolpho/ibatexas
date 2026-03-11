// lib/stabilize.ts — State Stabilization Barrier.
// Ensures products are indexed in Typesense with current Medusa state.
// Replaces the flaky 500ms setTimeout after product mutations.
//
// How it works:
//   1. Fetch full product data from Medusa (variants, prices, tags, categories, images)
//   2. Delete stale embedding cache (mirrors Medusa subscriber behavior)
//   3. Batch upsert to Typesense via indexProductsBatch()
//   4. Flush query cache (invalidateAllQueryCache)
//
// Idempotent: Typesense upsert is safe for double-indexing.
// The Medusa subscriber still handles non-CLI mutations (admin UI, API calls).

import chalk from "chalk"
import { medusaFetch, getAdminToken } from "./medusa.js"

// ── Types ────────────────────────────────────────────────────────────────────

interface MedusaProductResponse {
  product?: unknown
}

// ── Core stabilization ───────────────────────────────────────────────────────

/**
 * Fetch full product data for one or more product IDs from the Medusa admin API.
 * Returns the rich product objects needed for Typesense indexing.
 *
 * Uses the same field expansion as `ibx db reindex` and the product.updated subscriber:
 *   *variants, *variants.price_set, *variants.price_set.prices, *tags, *categories, *images
 */
async function fetchProductsForIndex(productIds: string[]): Promise<unknown[]> {
  const token = await getAdminToken()
  const products: unknown[] = []

  for (const id of productIds) {
    try {
      const data = await medusaFetch<MedusaProductResponse>(
        `/admin/products/${id}?fields=*variants,*variants.price_set,*variants.price_set.prices,*tags,*categories,*images`,
        { token },
      )
      if (data.product) {
        products.push(data.product)
      }
    } catch (err) {
      if (process.env.IBX_DEBUG_HTTP) {
        console.error(chalk.dim(`  [stabilize] Failed to fetch product ${id}: ${(err as Error).message}`))
      }
    }
  }

  return products
}

/**
 * Stabilize products: ensure Typesense index reflects current Medusa state.
 *
 * Call this after any product mutation (tag add/remove, metadata update)
 * instead of setTimeout(500). Fully synchronous — returns only when
 * all products are indexed and cache is flushed.
 *
 * @param productIds — Medusa product IDs to stabilize
 */
export async function stabilizeProducts(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return

  const {
    indexProductsBatch,
    invalidateAllQueryCache,
    deleteEmbeddingCache,
  } = await import("@ibatexas/tools")

  // 1. Fetch full products from Medusa
  const products = await fetchProductsForIndex(productIds)

  if (products.length === 0) return

  // 2. Delete stale embedding caches (force fresh embedding on next index)
  for (const id of productIds) {
    try {
      await deleteEmbeddingCache(id)
    } catch {
      // Best effort — embedding cache may not exist
    }
  }

  // 3. Upsert to Typesense (idempotent — safe for double-indexing)
  await indexProductsBatch(products)

  // 4. Flush query cache so stale search results aren't served
  await invalidateAllQueryCache()
}

/**
 * Verify a Typesense document matches expected state.
 *
 * Retrieves the Typesense document and runs a predicate against it.
 * Retries with polling if the first check fails (subscriber may still be running).
 *
 * @param productId — Typesense document ID (= Medusa product ID)
 * @param predicate — Returns true when document matches expected state
 * @param timeoutMs — Maximum wait time (default: 3000ms)
 * @param intervalMs — Polling interval (default: 200ms)
 * @returns true if predicate was satisfied within timeout
 */
export async function verifyTypesenseDoc(
  productId: string,
  predicate: (doc: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
  intervalMs = 200,
): Promise<boolean> {
  const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
  const ts = getTypesenseClient()
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const doc = await ts
        .collections(COLLECTION)
        .documents(productId)
        .retrieve() as Record<string, unknown>
      if (predicate(doc)) return true
    } catch {
      // Document might not exist yet — keep polling
    }

    if (Date.now() + intervalMs > deadline) break
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  return false
}
