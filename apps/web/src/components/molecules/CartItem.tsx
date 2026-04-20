import React from 'react'
import { QuantitySelector } from './QuantitySelector'
import { Link } from '@/i18n/navigation'
import { formatBRL } from '@/lib/format'
import { Trash2, ShoppingBag } from 'lucide-react'
import { useTranslations } from 'next-intl'
import NextImage from 'next/image'

interface CartItemProps {
  readonly id: string
  readonly productId: string
  readonly title: string
  readonly price: number
  readonly imageUrl?: string
  readonly quantity: number
  readonly specialInstructions?: string
  readonly variantTitle?: string
  readonly productType?: 'food' | 'frozen' | 'merchandise'
  readonly isKitchenClosed?: boolean
  readonly onQuantityChange: (quantity: number) => void
  readonly onRemove: () => void
}

export const CartItem: React.FC<CartItemProps> = ({
  productId,
  title,
  price,
  imageUrl,
  quantity,
  variantTitle,
  productType,
  isKitchenClosed,
  onQuantityChange,
  onRemove,
}) => {
  const t = useTranslations('cart')
  const lineTotal = formatBRL(price * quantity)
  const isFoodUnavailable = isKitchenClosed && productType === 'food'

  return (
    <div className={`flex gap-3 py-3 border-b border-smoke-200 last:border-0 ${isFoodUnavailable ? 'opacity-50' : ''}`}>
      {/* Thumbnail — 64px, clickable */}
      <Link href={`/loja/produto/${productId}`} className="flex-shrink-0">
        <div className="w-16 h-16 rounded-sm overflow-hidden bg-smoke-100">
          {imageUrl ? (
            <NextImage
              src={imageUrl}
              alt={title}
              width={64}
              height={64}
              placeholder="blur"
              blurDataURL="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjEwIj48cmVjdCBmaWxsPSIjZThlNGUwIiB3aWR0aD0iOCIgaGVpZ2h0PSIxMCIvPjwvc3ZnPg=="
              className="object-cover w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-smoke-300" strokeWidth={1.5} />
            </div>
          )}
        </div>
      </Link>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <Link href={`/loja/produto/${productId}`} className="min-w-0">
            <h3 className="text-sm font-medium text-charcoal-900 truncate hover:text-brand-600 transition-colors duration-300">
              {title}
            </h3>
          </Link>
          <span className="text-sm font-semibold text-charcoal-900 tabular-nums flex-shrink-0">
            {lineTotal}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {variantTitle && (
            <p className="text-xs text-[var(--color-text-secondary)]">{variantTitle}</p>
          )}
          {isFoodUnavailable && (
            <span className="text-micro font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-sm">
              {t('item_unavailable')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 mt-1">
          <button
            onClick={onRemove}
            className="w-7 h-7 flex items-center justify-center rounded-sm border border-smoke-200 text-[var(--color-text-secondary)] hover:text-accent-red hover:border-accent-red/30 transition-colors duration-300"
            aria-label={t('remove_item', { title })}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <QuantitySelector
            quantity={quantity}
            onQuantityChange={onQuantityChange}
            min={1}
            max={99}
            size="xs"
          />
        </div>
      </div>
    </div>
  )
}
