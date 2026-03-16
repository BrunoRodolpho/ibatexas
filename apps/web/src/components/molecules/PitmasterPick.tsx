'use client'

import { ChefHat, Plus, Minus, Check } from 'lucide-react'
import { useTranslations } from 'next-intl'
import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { track } from '@/domains/analytics'
import { useState, useCallback } from 'react'
import type { ProductDTO } from '@ibatexas/types'

interface PitmasterPickProps {
  readonly product: ProductDTO | null
  readonly onAddToCart?: (productId: string) => void
  /** Current quantity in cart */
  readonly cartQuantity?: number
  /** Callback to update quantity in cart */
  readonly onUpdateQuantity?: (qty: number) => void
  /** Callback to remove item from cart */
  readonly onRemoveFromCart?: () => void
  /** Display variant: 'card' (default, homepage) or 'inline' (compact, search page) */
  readonly variant?: 'card' | 'inline'
}

/**
 * Pitmaster Recommendation — daily curated pick.
 * Creates human connection and authority signal.
 */
export function PitmasterPick({ product, onAddToCart, cartQuantity = 0, onUpdateQuantity, onRemoveFromCart, variant = 'card' }: PitmasterPickProps) {
  const t = useTranslations()
  const [isAdded, setIsAdded] = useState(false)

  const handleQuickAdd = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!product) return
    track('quick_add_clicked', { productId: product.id, source: 'pitmaster_pick' })
    onAddToCart?.(product.id)
    setIsAdded(true)
    setTimeout(() => setIsAdded(false), 2000)
  }, [product, onAddToCart])

  const handleIncrement = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!product) return
    track('quantity_changed_inline', { productId: product.id, action: 'increment', quantity: cartQuantity + 1 })
    onUpdateQuantity?.(cartQuantity + 1)
  }, [product, cartQuantity, onUpdateQuantity])

  const handleDecrement = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!product) return
    if (cartQuantity <= 1) {
      track('quantity_changed_inline', { productId: product.id, action: 'remove', quantity: 0 })
      onRemoveFromCart?.()
    } else {
      track('quantity_changed_inline', { productId: product.id, action: 'decrement', quantity: cartQuantity - 1 })
      onUpdateQuantity?.(cartQuantity - 1)
    }
  }, [product, cartQuantity, onUpdateQuantity, onRemoveFromCart])

  if (!product) return null

  const priceFormatted = (product.price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
  const displayImage = product.imageUrl || product.images?.[0] || null

  // ── Inline variant (compact, for search page) ──────────────────
  if (variant === 'inline') {
    return (
      <div className="mb-4">
        <div className="surface-card rounded-card overflow-hidden">
          <div className="flex items-center gap-3 p-3 sm:p-4">
            <div className="relative w-16 h-16 flex-shrink-0 rounded-sm overflow-hidden bg-smoke-100">
              {displayImage ? (
                <NextImage
                  src={displayImage}
                  alt={product.title}
                  fill
                  sizes="64px"
                  placeholder="blur"
                  blurDataURL={BLUR_PLACEHOLDER}
                  className="object-cover"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
                  <span className="font-display text-[6px] tracking-[0.15em] text-smoke-300/30 uppercase">IbateXas</span>
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <ChefHat className="w-3 h-3 text-brand-500" strokeWidth={2} />
                <span className="text-[9px] uppercase tracking-editorial text-brand-500 font-semibold">
                  {t('pitmaster_pick.label')}
                </span>
              </div>
              <h3 className="font-display text-sm font-medium text-charcoal-900 leading-snug truncate">
                <Link href={`/products/${product.id}`}>
                  {product.title}
                </Link>
              </h3>
              <span className="text-sm font-semibold tabular-nums text-charcoal-900">
                {priceFormatted}
              </span>
            </div>
            {onAddToCart && (
              <div className="flex-shrink-0">
                <button
                  onClick={handleQuickAdd}
                  className={`inline-flex items-center gap-1 text-xs font-medium px-3 py-2 rounded-sm transition-all duration-300 ease-luxury active:scale-95 ${
                    isAdded
                      ? 'bg-accent-green text-white'
                      : 'bg-brand-500 text-white hover:bg-brand-600'
                  }`}
                  aria-label={`${t('product.add_to_cart')} - ${product.title}`}
                >
                  {isAdded ? (
                    <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                  ) : (
                    <Plus className="w-3.5 h-3.5" strokeWidth={2} />
                  )}
                  {t('common.add')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Card variant (default, homepage) ───────────────────────────
  return (
    <section>
      <div className="surface-card rounded-card overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          {/* Image side */}
          <div className="relative w-full sm:w-48 h-48 sm:h-auto flex-shrink-0 overflow-hidden bg-smoke-100">
            {displayImage ? (
              <>
                <NextImage
                  src={displayImage}
                  alt={product.title}
                  fill
                  sizes="(max-width: 640px) 100vw, 192px"
                  placeholder="blur"
                  blurDataURL={BLUR_PLACEHOLDER}
                  className="object-cover"
                />
                <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
              </>
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
                <span className="font-display text-xs tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
              </div>
            )}
          </div>

          {/* Content side */}
          <div className="flex-1 p-5 sm:p-6 flex flex-col justify-center">
            {/* Label */}
            <div className="flex items-center gap-2 mb-3">
              <ChefHat className="w-4 h-4 text-brand-500" strokeWidth={2} />
              <span className="text-[10px] uppercase tracking-editorial text-brand-500 font-semibold">
                {t('pitmaster_pick.label')}
              </span>
            </div>

            {/* Product info */}
            <h3 className="font-display text-display-2xs font-semibold text-charcoal-900 tracking-display mb-1">
              <Link href={`/products/${product.id}`}>
                {product.title}
              </Link>
            </h3>
            <p className="text-sm text-smoke-500 mb-3 font-display italic">
              {product.description || t('pitmaster_pick.description')}
            </p>

            {/* Price + CTA */}
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold tabular-nums text-charcoal-900">
                {priceFormatted}
              </span>
              {onAddToCart && (
                <div className="relative z-10">
                  {cartQuantity > 0 && onUpdateQuantity ? (
                    <div className="flex items-center bg-charcoal-900 rounded-sm h-9 overflow-hidden">
                      <button
                        onClick={handleDecrement}
                        className="w-10 h-9 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all"
                        aria-label={t('common.decrease_quantity')}
                      >
                        <Minus className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                      <span className="text-xs font-bold text-smoke-50 tabular-nums min-w-[1.25rem] text-center">{cartQuantity}</span>
                      <button
                        onClick={handleIncrement}
                        className="w-10 h-9 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all"
                        aria-label={t('common.increase_quantity')}
                      >
                        <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleQuickAdd}
                      className={`inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-sm transition-all duration-300 ease-luxury active:scale-95 ${
                        isAdded
                          ? 'bg-accent-green text-white animate-add-success'
                          : 'bg-brand-500 text-white hover:bg-brand-600'
                      }`}
                    >
                      {isAdded ? (
                        <>
                          <Check className="w-4 h-4" strokeWidth={2.5} />
                          {t('product.added_short')}
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" strokeWidth={2} />
                          {t('common.add')}
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
