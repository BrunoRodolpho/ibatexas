'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Star } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { trackOnceVisible } from '@/domains/analytics'
import { Link } from '@/i18n/navigation'
import { Container } from '@/components/atoms'

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
      `/api/products/${product.id}/reviews?limit=5`,
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
  const products = (res.items ?? res.products ?? []).slice(0, 5)
  if (products.length === 0) return []

  const reviewSets = await Promise.all(
    products.map((product) => fetchProductReviews(product, signal)),
  )
  // Return everything sorted — the render layer decides how many to show.
  // Was `.slice(0, 6)`, which combined with thin seed data left the right
  // column half-empty.
  return sortReviews(reviewSets.flat())
}

/** Format an ISO date to a short pt-BR string like "12 mar 2026" */
function formatReviewDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

/** Pull initials from a customer name for the avatar circle */
function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '·'
}

/**
 * Customer reviews — editorial two-column layout.
 *
 * Replaced the previous "row of pale cards" design (which the user explicitly
 * called ugly) with:
 *   - Left column: a hero pull-quote from the highest-rated review, set in
 *     the display serif at large size, with a 5-star row and attribution
 *     below. On mobile this becomes a single quote card at the top.
 *   - Right column: a vertical stack of three review cards with avatar
 *     initials, full review text (no 3-line clamp), and a clean separator.
 *
 * Background switches to `bg-smoke-100` to distinguish the section from its
 * neighbors. Borders use full opacity (was `border-smoke-200/40` — invisible).
 */
export function HomeReviews() {
  const t = useTranslations()
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const sectionRef = useRef<HTMLElement>(null)

  // Track section visibility once it enters the viewport
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

  // Pick the hero review and the supporting stack. Memoized so the split is
  // stable across re-renders.
  const { heroReview, supportingReviews } = useMemo(() => {
    if (reviews.length === 0) return { heroReview: null, supportingReviews: [] as ReviewItem[] }
    const [first, ...rest] = reviews
    return { heroReview: first, supportingReviews: rest.slice(0, 3) }
  }, [reviews])

  if (!heroReview) return null

  // When no supporting reviews are available (thin seed data), the 5/7 grid
  // leaves the right column looking empty. Collapse to a single centered
  // hero quote instead — better to show one strong quote full-width than
  // an awkward half-empty grid.
  const isHeroOnly = supportingReviews.length === 0

  return (
    <section ref={sectionRef} className="bg-smoke-100">
      <Container size="xl" className="py-16 lg:py-24">
        {/* Section header — small caps eyebrow, then headline */}
        <div className="mb-10 lg:mb-14">
          <p className="text-[11px] font-semibold uppercase tracking-editorial text-brand-600">
            {t('reviews_section.subtitle')}
          </p>
          <h2 className="mt-2 font-display text-display-xs sm:text-display-sm font-semibold text-charcoal-900 tracking-display max-w-[640px]">
            {t('reviews_section.title')}
          </h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16">
          {/* ── Hero pull-quote ─────────────────────────────────── */}
          <figure
            className={
              isHeroOnly
                ? 'lg:col-span-12 max-w-[820px] mx-auto flex flex-col items-center text-center'
                : 'lg:col-span-5 flex flex-col'
            }
          >
            {/* Decorative quote mark — only in the 5/7 layout. In hero-only
                mode the centered pull-quote stands on its own and the leading
                glyph just looks misaligned at 120px. */}
            {!isHeroOnly && (
              <div
                aria-hidden
                className="font-display text-[120px] leading-[0.6] text-brand-500/20 select-none -mb-6"
              >
                &ldquo;
              </div>
            )}
            <blockquote className="font-display italic text-2xl sm:text-3xl text-charcoal-800 leading-[1.35] tracking-[-0.005em]">
              {heroReview.comment}
            </blockquote>
            <div className="mt-6 flex items-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={`hero-star-${i}`}
                  className={
                    i < heroReview.rating
                      ? 'w-5 h-5 fill-brand-500 text-brand-500'
                      : 'w-5 h-5 fill-smoke-200 text-smoke-200'
                  }
                />
              ))}
            </div>
            <figcaption className="mt-4">
              <p className="text-sm font-semibold text-charcoal-900">
                {heroReview.customerName}
              </p>
              {/* Product attribution doubles as the "see more" affordance —
                  the link goes to the product's PDP where the full reviews
                  section lives. Removed the redundant "Ver mais avaliações →"
                  link below it: same destination, vague label, the user found
                  it confusing. The product line here makes the destination
                  obvious ("see this product"). */}
              <Link
                href={`/loja/produto/${heroReview.productId}`}
                className="mt-1 inline-flex items-center gap-1 text-xs uppercase tracking-editorial text-smoke-500 hover:text-brand-600 transition-colors"
              >
                {heroReview.productTitle}
                <span aria-hidden>→</span>
              </Link>
            </figcaption>
          </figure>

          {/* ── Supporting reviews stack ─────────────────────────── */}
          {!isHeroOnly && (
          <div className="lg:col-span-7 flex flex-col divide-y divide-smoke-200">
            {supportingReviews.map((review) => (
              <article key={review.id} className="py-6 first:pt-0 last:pb-0">
                <div className="flex items-center gap-1 mb-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={`${review.id}-star-${i}`}
                      className={
                        i < review.rating
                          ? 'w-4 h-4 fill-brand-500 text-brand-500'
                          : 'w-4 h-4 fill-smoke-200 text-smoke-200'
                      }
                    />
                  ))}
                </div>
                <p className="font-display italic text-base text-charcoal-700 leading-relaxed line-clamp-5">
                  {review.comment}
                </p>
                <div className="mt-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-charcoal-900 text-smoke-50 flex items-center justify-center text-xs font-semibold">
                    {initialsFor(review.customerName)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-charcoal-900">
                      {review.customerName}
                    </p>
                    <Link
                      href={`/loja/produto/${review.productId}`}
                      className="text-[11px] uppercase tracking-editorial text-smoke-500 hover:text-brand-600 transition-colors"
                    >
                      {review.productTitle}
                    </Link>
                  </div>
                  {review.createdAt && (
                    <span className="text-[11px] text-smoke-500 tabular-nums whitespace-nowrap">
                      {formatReviewDate(review.createdAt)}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
          )}
        </div>
      </Container>
    </section>
  )
}
