'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Star } from 'lucide-react'
import {
  fetchReviewableOrders,
  submitOrderReview,
  isValidRating,
  MAX_RATING,
  type ReviewableOrder,
} from '@/domains/account/reviews'

/**
 * CUS-049 (web view) — product reviews for delivered orders. Loads the
 * customer's reviewable orders (delivered + productId-bearing items) and lets
 * them rate 1–5 stars with an optional comment. Each submit posts through the
 * governed POST /api/me/reviews (kernel-adjudicated, owner-scoped). A submitted
 * item collapses to a thank-you so it can't be double-sent from the same view.
 */
type ItemStatus = 'idle' | 'submitting' | 'done' | 'error'
interface Draft {
  rating: number
  comment: string
  status: ItemStatus
}

function keyOf(orderId: string, productId: string): string {
  return `${orderId}::${productId}`
}

export function ProductReviewsCard(): React.JSX.Element {
  const t = useTranslations('account')
  const [orders, setOrders] = useState<ReviewableOrder[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  useEffect(() => {
    let alive = true
    fetchReviewableOrders().then((o) => {
      if (alive) setOrders(o)
    })
    return () => {
      alive = false
    }
  }, [])

  function draftFor(k: string): Draft {
    return drafts[k] ?? { rating: 0, comment: '', status: 'idle' }
  }

  function patchDraft(k: string, patch: Partial<Draft>): void {
    setDrafts((prev) => ({ ...prev, [k]: { ...draftFor(k), ...patch } }))
  }

  async function handleSubmit(orderId: string, productId: string): Promise<void> {
    const k = keyOf(orderId, productId)
    const draft = draftFor(k)
    if (!isValidRating(draft.rating)) {
      patchDraft(k, { status: 'error' })
      return
    }
    patchDraft(k, { status: 'submitting' })
    try {
      await submitOrderReview({
        orderId,
        productId,
        rating: draft.rating,
        ...(draft.comment.trim() ? { comment: draft.comment } : {}),
      })
      patchDraft(k, { status: 'done' })
    } catch {
      patchDraft(k, { status: 'error' })
    }
  }

  const hasOrders = orders !== null && orders.length > 0

  return (
    <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium md:col-span-2">
      <div className="flex items-center gap-2">
        <Star className="w-4 h-4 text-smoke-400" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
          {t('reviews.title')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">{t('reviews.description')}</p>

      {!hasOrders && (
        <p className="mt-3 text-sm text-smoke-400">{t('reviews.empty')}</p>
      )}

      {hasOrders && (
        <div className="mt-4 space-y-5">
          {orders.map((order) => (
            <div key={order.orderId} className="border-t border-smoke-200/60 pt-4 first:border-t-0 first:pt-0">
              <div className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
                {t('reviews.order_label', { id: order.displayId })}
              </div>
              <div className="mt-2 space-y-4">
                {order.items.map((item) => {
                  const k = keyOf(order.orderId, item.productId)
                  const draft = draftFor(k)
                  if (draft.status === 'done') {
                    return (
                      <div key={k} className="text-sm text-brand-600">
                        {item.title} — {t('reviews.submitted')}
                      </div>
                    )
                  }
                  return (
                    <div key={k} className="space-y-2">
                      <div className="text-sm text-charcoal-700">{item.title}</div>
                      <div className="flex items-center gap-1">
                        {Array.from({ length: MAX_RATING }, (_, i) => i + 1).map((star) => (
                          <button
                            key={star}
                            type="button"
                            aria-label={`${star}`}
                            onClick={() => patchDraft(k, { rating: star, status: 'idle' })}
                            disabled={draft.status === 'submitting'}
                            className="p-0.5 disabled:opacity-50"
                          >
                            <Star
                              className={`w-5 h-5 ${star <= draft.rating ? 'fill-brand-500 text-brand-500' : 'text-smoke-300'}`}
                            />
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={draft.comment}
                        onChange={(e) => patchDraft(k, { comment: e.target.value, status: 'idle' })}
                        disabled={draft.status === 'submitting'}
                        placeholder={t('reviews.comment_placeholder')}
                        maxLength={1000}
                        rows={2}
                        className="w-full rounded-sm border border-smoke-200 bg-white p-2 text-sm text-charcoal-700 disabled:opacity-50"
                      />
                      <button
                        type="button"
                        onClick={() => handleSubmit(order.orderId, item.productId)}
                        disabled={draft.status === 'submitting'}
                        className="inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
                      >
                        {draft.status === 'submitting' ? t('reviews.submitting') : `${t('reviews.submit')} →`}
                      </button>
                      {draft.status === 'error' && (
                        <p className="text-sm text-accent-red">
                          {isValidRating(draft.rating) ? t('reviews.error') : t('reviews.rating_required')}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
