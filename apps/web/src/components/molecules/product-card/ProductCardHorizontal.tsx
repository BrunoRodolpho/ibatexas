'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'

import { ProductImage } from './ProductImage'
import { QuantityControls } from './QuantityControls'
import type { ProductCardData, CartState, CardCallbacks } from './types'

interface ProductCardHorizontalProps {
  readonly data: ProductCardData
  readonly cart: CartState
  readonly callbacks: CardCallbacks
  readonly priority?: boolean
  /** Pre-computed values passed from facade */
  readonly computed: {
    displayImage: string | null
    linkHref: string
    priceFormatted: string
  }
  /** Event handlers from facade */
  readonly handlers: {
    handleQuickAdd: (e: React.MouseEvent) => void
    handleIncrement: (e: React.MouseEvent) => void
    handleDecrement: (e: React.MouseEvent) => void
    handleCardClick: () => void
  }
}

export function ProductCardHorizontal({
  data,
  cart,
  callbacks,
  priority,
  computed,
  handlers,
}: ProductCardHorizontalProps) {
  const t = useTranslations()

  return (
    <div className="group relative">
      <div className="surface-card rounded-card overflow-hidden transition-all duration-500 ease-luxury group-hover:shadow-card-hover">
        <div className="flex flex-row">
          {/* Square thumbnail */}
          <div className="relative w-28 h-28 flex-shrink-0 overflow-hidden bg-smoke-100">
            <ProductImage displayImage={computed.displayImage} title={data.title} priority={priority} sizes="112px" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 py-2 px-3 flex items-center">
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-sm font-medium text-charcoal-900 leading-snug truncate">
                <Link href={computed.linkHref} className="after:absolute after:inset-0 after:content-['']" onClick={handlers.handleCardClick}>
                  {data.title}
                </Link>
              </h3>
              {data.subtitle && (
                <p className="mt-0.5 text-xs text-smoke-500 truncate">{data.subtitle}</p>
              )}
              <span className="mt-1 block text-sm font-semibold tabular-nums text-charcoal-900">
                {computed.priceFormatted}
              </span>
            </div>

            {/* Inline add / quantity */}
            {callbacks.onAddToCart && (
              <div className="relative z-10 flex-shrink-0 ml-2">
                {cart.quantity > 0 && callbacks.onUpdateQuantity ? (
                  <QuantityControls cartQuantity={cart.quantity} onDecrement={handlers.handleDecrement} onIncrement={handlers.handleIncrement} size="sm" t={t} />
                ) : (
                  <button
                    onClick={handlers.handleQuickAdd}
                    className="w-9 h-9 rounded-full bg-brand-500 text-white flex items-center justify-center shadow-md hover:bg-brand-600 active:scale-90 transition-all duration-300 ease-luxury"
                    aria-label={`${t('product.add_to_cart')} - ${data.title}`}
                  >
                    <Plus className="w-4 h-4" strokeWidth={2.5} />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
