// Batch sync review stats from Prisma → Typesense.
// Used by seed pipelines to ensure Typesense rating/reviewCount fields
// reflect all reviews in Prisma after bulk seeding.
//
// In production, individual reviews sync incrementally via submit-review.ts.

import { prisma } from "@ibatexas/domain"
import { getTypesenseClient, COLLECTION } from "../typesense/client.js"

interface SyncResult {
  synced: number
  skipped: number
}

/**
 * Aggregate all reviews by productId and update each product's
 * `rating` and `reviewCount` fields in Typesense.
 */
export async function syncReviewStats(): Promise<SyncResult> {
  // 1. Aggregate reviews grouped by productId
  const stats = await prisma.review.groupBy({
    by: ["productId"],
    _avg: { rating: true },
    _count: { rating: true },
    where: { productId: { not: null } },
  })

  if (stats.length === 0) {
    return { synced: 0, skipped: 0 }
  }

  // 2. Update each product in Typesense
  const typesense = getTypesenseClient()
  let synced = 0
  let skipped = 0

  for (const row of stats) {
    const productId = row.productId
    if (!productId) {
      skipped++
      continue
    }

    const avgRating = row._avg.rating ?? 0
    const reviewCount = row._count.rating

    try {
      await typesense
        .collections<Record<string, unknown>>(COLLECTION)
        .documents(productId)
        .update({ rating: avgRating, reviewCount })
      synced++
    } catch {
      // Non-fatal: product may not be indexed in Typesense yet
      skipped++
    }
  }

  return { synced, skipped }
}
