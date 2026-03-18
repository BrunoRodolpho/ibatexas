// ReviewService — centralizes review queries.
//
// Handles: product review listing, aggregate stats for Typesense sync.
// Review creation stays in CustomerService (it's part of the customer flow).

import { prisma } from "../client.js"

// ── Service ───────────────────────────────────────────────────────────────────

export function createReviewService() {
  return {
    /**
     * List reviews for a product with pagination.
     * Used by GET /api/products/:id/reviews.
     */
    async findForProduct(
      productId: string,
      opts: { limit: number; offset: number },
    ) {
      const [reviews, total] = await Promise.all([
        prisma.review.findMany({
          where: { productId },
          orderBy: { createdAt: "desc" },
          take: opts.limit,
          skip: opts.offset,
          include: {
            customer: { select: { id: true, name: true } },
          },
        }),
        prisma.review.count({ where: { productId } }),
      ])

      return { reviews, total }
    },

    /**
     * Aggregate all review stats grouped by product.
     * Used by batch sync pipeline (sync-review-stats.ts).
     */
    async aggregateAll() {
      return prisma.review.groupBy({
        by: ["productId"],
        _avg: { rating: true },
        _count: { rating: true },
        where: { productId: { not: null } },
      })
    },
  }
}

export type ReviewService = ReturnType<typeof createReviewService>
