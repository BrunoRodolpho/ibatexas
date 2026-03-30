'use client'

import { formatBRL } from '@/lib/format'
import type { T } from './types'

interface PriceBlockProps {
  readonly price: number
  readonly priceFormatted: string
  readonly compareAtPrice?: number
  readonly hasDiscount: boolean
  readonly discountPercent: number
  readonly hasMultipleVariants: boolean
  readonly t: T
}

export function PriceBlock({
  price,
  priceFormatted,
  compareAtPrice,
  hasDiscount,
  discountPercent,
  hasMultipleVariants,
  t,
}: PriceBlockProps) {
  return (
    <div className="mt-auto pt-2 flex items-baseline gap-1.5">
      {hasMultipleVariants && (
        <span className="text-[10px] text-[var(--color-text-secondary)]">{t('product.from_price')}</span>
      )}
      {hasDiscount && compareAtPrice && (
        <span className="text-xs text-[var(--color-text-muted)] line-through">
          {formatBRL(compareAtPrice)}
        </span>
      )}
      <span className="text-lg font-semibold tracking-tight text-charcoal-900 tabular-nums">
        {priceFormatted}
      </span>
      {hasDiscount && discountPercent > 0 && price < 15000 && (
        <span className="text-xs text-accent-green font-medium">-{discountPercent}%</span>
      )}
    </div>
  )
}
