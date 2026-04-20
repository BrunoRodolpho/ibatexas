'use client'

import { Star, Flame } from 'lucide-react'
import { formatRating } from '@/lib/format'
import type { T } from './types'

interface SocialProofProps {
  readonly rating?: number
  readonly reviewCount?: number
  readonly tags?: readonly string[]
  readonly ordersToday?: number
  readonly t: T
}

export function SocialProof({
  rating,
  reviewCount,
  tags,
  ordersToday,
  t,
}: SocialProofProps) {
  const showRating = rating && rating >= 4 && reviewCount && reviewCount >= 10

  return (
    <>
      {showRating && (
        <div className="mt-1.5 inline-flex items-center gap-1">
          <Star className="w-3 h-3 fill-brand-500 text-brand-500" />
          <span className="text-xs text-charcoal-900 font-medium tabular-nums">
            {formatRating(rating)}
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">({reviewCount})</span>
        </div>
      )}
      {tags?.includes('popular') && reviewCount && reviewCount > 50 && (
        <p className="text-xs text-[var(--color-text-secondary)]">{t('product.ordered_count', { count: reviewCount })}</p>
      )}
      {ordersToday != null && ordersToday >= 5 && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-brand-600 font-medium">
          <Flame className="w-3 h-3" strokeWidth={2} />
          {t('product.orders_today', { count: ordersToday })}
        </p>
      )}
    </>
  )
}
