'use client'

import { useTranslations } from 'next-intl'

interface ScarcityRibbonProps {
  stockCount: number
  /** Maximum stock level to show the ribbon. Default: 5 */
  threshold?: number
  className?: string
}

/**
 * Scarcity ribbon — shows when stock is low to create urgency.
 * Only renders when stockCount is defined and ≤ threshold.
 */
export function ScarcityRibbon({ stockCount, threshold = 5, className = '' }: ScarcityRibbonProps) {
  const t = useTranslations()

  if (stockCount > threshold) return null

  return (
    <div
      className={`bg-brand-500 text-white text-xs font-medium px-3 py-1 rounded-sm inline-block ${className}`}
    >
      {t('product.scarcity', { count: stockCount })}
    </div>
  )
}
