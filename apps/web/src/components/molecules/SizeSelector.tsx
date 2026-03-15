'use client'

import { useTranslations } from 'next-intl'
import { Button } from '../atoms'
import clsx from 'clsx'
import type { ProductVariant } from '@ibatexas/types'
import { formatBRL } from '@/lib/format'

interface SizeSelectorProps {
  variants: ProductVariant[]
  selectedVariant: string
  onVariantChange: (variantId: string) => void
  disabled?: boolean
}

export const SizeSelector = ({
  variants,
  selectedVariant,
  onVariantChange,
  disabled = false,
}: SizeSelectorProps) => {
  const t = useTranslations()

  // Map size titles to display labels
  const getSizeLabel = (title: string | null): string => {
    if (!title) return 'Único'
    
    const sizeMap: Record<string, string> = {
      'P': t('shop.sizes.p'),
      'M': t('shop.sizes.m'),
      'G': t('shop.sizes.g'),
      'GG': t('shop.sizes.gg'),
      'Único': t('shop.sizes.unico'),
    }
    
    return sizeMap[title] || title
  }

  return (
    <div role="radiogroup" aria-label={t('product.variants')} className="flex flex-wrap gap-3">
      {variants.map((variant) => {
        const isSelected = variant.id === selectedVariant
        const isOutOfStock = disabled
        const label = getSizeLabel(variant.title)
        const priceLabel = variant.price
          ? ` — ${formatBRL(variant.price)}`
          : ''
        
        return (
          <Button
            key={variant.id}
            role="radio"
            aria-checked={isSelected}
            variant={isSelected ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => onVariantChange(variant.id)}
            disabled={isOutOfStock}
            className={clsx(
              'px-4 py-2 min-w-[3rem]',
              isSelected && 'ring-2 ring-brand-500 ring-offset-2',
              isOutOfStock && 'opacity-50 cursor-not-allowed'
            )}
          >
            {label}{priceLabel}
          </Button>
        )
      })}
    </div>
  )
}