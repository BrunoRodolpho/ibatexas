'use client'

import { useEffect, useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Star, Quote } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { trackOnceVisible } from '@/domains/analytics'
import { Link } from '@/i18n/navigation'

interface ReviewItem {
  id: string
  rating: number
  comment: string
  createdAt: string
  customerName: string
  productId: string
  productTitle: string
}

interface ReviewResponse {
  reviews: Array<{
    id: string
    rating: number
    comment: string
    createdAt: string
    customerName: string
  }>
  total: number
  averageRating: number | null
}

/** Fetch reviews for a single product, filtering to 4+ stars with comments */
async function fetchProductReviews(
  product: { id: string; title: string },
  signal: AbortSignal,
): Promise<ReviewItem[]> {
  try {
    const data = await apiFetch<ReviewResponse>(
      `/api/products/${product.id}/reviews?limit=3`,
      { signal },
    )
    return data.reviews
      .filter((r) => r.rating >= 4 && r.comment)
      .map((r) => ({
        ...r,
        productId: product.id,
        productTitle: product.title,
      }))
  } catch {
    // Individual fetch failure — skip product
    return []
  }
}

/** Sort reviews by rating desc, then by date desc */
function sortReviews(reviews: ReviewItem[]): ReviewItem[] {
  return [...reviews].sort(
    (a, b) => b.rating - a.rating || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

/** Fetch top reviews from popular products */
async function loadTopReviews(signal: AbortSignal): Promise<ReviewItem[]> {
  const res = await apiFetch<{ items?: Array<{ id: string; title: string }>; products?: Array<{ id: string; title: string }> }>(
    '/api/products?sort=rating_desc&limit=6',
    { signal },
  )
  const products = (res.items ?? res.products ?? []).slice(0, 3)
  if (products.length === 0) return []

  const reviewSets = await Promise.all(
    products.map((product) => fetchProductReviews(product, signal)),
  )
  return sortReviews(reviewSets.flat()).slice(0, 6)
}

/**
 * Customer reviews section for the homepage.
 * Fetches top reviews from popular product IDs and displays
 * them in a horizontally scrollable strip.
 */
export function HomeReviews() {
  const t = useTranslations()
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const sectionRef = useRef<HTMLElement>(null)

  // Track section visibility
  useEffect(() => {
    if (sectionRef.current) {
      trackOnceVisible(sectionRef.current, 'review_section_viewed', {})
    }
  }, [reviews.length])

  useEffect(() => {
    const controller = new AbortController()

    loadTopReviews(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) {
          setReviews(loaded)
        }
      })
      .catch(() => {
        // Silently fail — reviews are not critical
      })

    return () => controller.abort()
  }, [])

  if (reviews.length === 0) return null

  return (
    <section ref={sectionRef} className="bg-smoke-50 border-t border-smoke-200/30">
      <div className="mx-auto max-w-[1280px] px-6 lg:px-8 py-16 lg:py-24">
        {/* Section header */}
        <div className="mb-8">
          <h2 className="font-display text-display-xs sm:text-display-sm font-semibold text-charcoal-900 tracking-display">
            {t('reviews_section.title')}
          </h2>
          <p className="mt-2 text-sm text-smoke-400">
            {t('reviews_section.subtitle')}
          </p>
        </div>

        {/* Horizontal scroll — snap to card edges */}
        <div className="flex gap-4 overflow-x-auto scrollbar-hide snap-x snap-mandatory -mx-4 px-4 sm:mx-0 sm:px-0 pb-2">
          {reviews.map((review) => (
            <div
              key={review.id}
              className="snap-start flex-shrink-0 w-[280px] sm:w-[300px]"
            >
              <div className="surface-card rounded-card p-5 h-full flex flex-col">
                {/* Star rating */}
                <div className="flex items-center gap-0.5 mb-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={`${review.id}-star-${i}`}
                      className={`w-3.5 h-3.5 ${
                        i < review.rating
                          ? 'fill-brand-500 text-brand-500'
                          : 'fill-smoke-200 text-smoke-200'
                      }`}
                    />
                  ))}
                </div>

                {/* Comment */}
                <div className="flex-1 mb-3">
                  <Quote className="w-4 h-4 text-smoke-200 mb-1" strokeWidth={1.5} />
                  <p className="text-sm text-charcoal-700 italic line-clamp-3 leading-relaxed">
                    {review.comment}
                  </p>
                </div>

                {/* Customer + product */}
                <div className="pt-3 border-t border-smoke-200/40">
                  <p className="text-xs font-medium text-charcoal-900">
                    {review.customerName}
                  </p>
                  <Link
                    href={`/products/${review.productId}`}
                    className="text-[11px] text-smoke-400 hover:text-brand-500 transition-colors"
                  >
                    {review.productTitle}
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
