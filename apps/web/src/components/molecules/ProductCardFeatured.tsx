'use client'

import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Minus, Check } from 'lucide-react'
import { Badge, type BadgeProps } from '../atoms'
import { track } from '@/domains/analytics'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { useState, useCallback } from 'react'

/** Badge priority order — first match wins (only 1 badge shown) */
const BADGE_PRIORITY = ['edicao_limitada', 'chef_choice', 'popular', 'novo'] as const

interface ProductCardFeaturedProps {
  readonly id: string
  readonly title: string
  readonly subtitle?: string
  readonly imageUrl?: string | null
  readonly images?: string[]
  readonly price: number
  readonly variantCount?: number
  readonly tags?: string[]
  readonly href?: string
  readonly onAddToCart?: () => void
  /** Current quantity in cart (0 or undefined = not in cart) */
  readonly cartQuantity?: number
  /** Callback to update quantity in cart */
  readonly onUpdateQuantity?: (qty: number) => void
  /** Callback to remove item from cart */
  readonly onRemoveFromCart?: () => void
}

export const ProductCardFeatured = ({
  id,
  title,
  subtitle,
  imageUrl,
  images,
  price,
  variantCount: _variantCount,
  tags,
  href,
  onAddToCart,
  cartQuantity = 0,
  onUpdateQuantity,
  onRemoveFromCart,
}: ProductCardFeaturedProps) => {
  const t = useTranslations()
  const [isAdded, setIsAdded] = useState(false)

  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  const displayImage = imageUrl || images?.[0] || null
  const linkHref = href || `/products/${id}`

  // Single priority badge (first match wins)
  const priorityTag = tags?.find((tag) =>
    BADGE_PRIORITY.includes(tag as (typeof BADGE_PRIORITY)[number])
  )

  const handleQuickAdd = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId: id, source: 'featured' })
    onAddToCart?.()
    setIsAdded(true)
    setTimeout(() => setIsAdded(false), 2000)
  }, [id, onAddToCart])

  const handleIncrement = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quantity_changed_inline', { productId: id, action: 'increment', quantity: cartQuantity + 1 })
    onUpdateQuantity?.(cartQuantity + 1)
  }, [id, cartQuantity, onUpdateQuantity])

  const handleDecrement = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (cartQuantity <= 1) {
      track('quantity_changed_inline', { productId: id, action: 'remove', quantity: 0 })
      onRemoveFromCart?.()
    } else {
      track('quantity_changed_inline', { productId: id, action: 'decrement', quantity: cartQuantity - 1 })
      onUpdateQuantity?.(cartQuantity - 1)
    }
  }, [id, cartQuantity, onUpdateQuantity, onRemoveFromCart])

  const handleCardClick = () => {
    track('product_card_clicked', { productId: id, source: 'featured' })
  }

  return (
    <div className="group relative">
      <div className="surface-card rounded-card overflow-hidden transition-all duration-500 ease-luxury group-hover:shadow-md group-hover:-translate-y-0.5">
        <div className="grid grid-cols-1 md:grid-cols-5">
          {/* Image — landscape on desktop, portrait on mobile */}
          <div className="relative md:col-span-3 aspect-[4/5] md:aspect-auto md:min-h-[360px] overflow-hidden bg-smoke-100">
            {displayImage ? (
              <>
                <NextImage
                  src={displayImage}
                  alt={title}
                  fill
                  priority
                  placeholder="blur"
                  blurDataURL={BLUR_PLACEHOLDER}
                  sizes="(max-width: 768px) 100vw, 60vw"
                  className="object-cover contrast-[1.08] group-hover:scale-[1.03] transition-transform duration-800 ease-luxury"
                />
                {/* Secondary image on hover */}
                {images && images.length >= 2 && images[1] !== displayImage && (
                  <NextImage
                    src={images[1]}
                    alt={`${title} — alternativa`}
                    fill
                    sizes="(max-width: 768px) 100vw, 60vw"
                    className="object-cover contrast-[1.08] absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury"
                  />
                )}
                {/* Warm overlay */}
                <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
              </>
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 grain-overlay flex items-center justify-center">
                <span className="font-display text-sm tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
              </div>
            )}

            {/* Hover gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-charcoal-900/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury pointer-events-none" />

            {/* Single priority badge */}
            {priorityTag && (
              <div className="absolute top-3 left-3 z-10">
                <Badge variant={priorityTag as BadgeProps['variant']}>
                  {priorityTag.replaceAll("_", " ")}
                </Badge>
              </div>
            )}
          </div>

          {/* Details — right side on desktop, below on mobile */}
          <div className="md:col-span-2 p-5 md:p-8 flex flex-col justify-center">
            <h3 className="font-display text-display-xs md:text-display-sm tracking-display text-charcoal-900 leading-snug group-hover:text-charcoal-700 transition-colors duration-500 ease-luxury">
              <Link href={linkHref} className="after:absolute after:inset-0 after:content-['']" onClick={handleCardClick}>
                {title}
              </Link>
            </h3>

            {subtitle && (
              <p className="mt-3 text-sm text-smoke-400 leading-relaxed">
                {subtitle}
              </p>
            )}

            <p className="mt-4 text-lg font-semibold tracking-tight text-charcoal-900 tabular-nums">
              {priceFormatted}
            </p>

            {/* CTA — always visible, orange primary action */}
            {onAddToCart && (
              <div className="relative z-10 mt-6">
                {cartQuantity > 0 && onUpdateQuantity ? (
                  /* Quantity controls — shown when item is in cart */
                  <div className="flex items-center bg-charcoal-900 rounded-sm h-11 overflow-hidden w-fit">
                    <button
                      onClick={handleDecrement}
                      className="w-12 h-11 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all"
                      aria-label={t('common.decrease_quantity')}
                    >
                      <Minus className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                    <span className="text-sm font-bold text-smoke-50 tabular-nums min-w-[1.5rem] text-center">{cartQuantity}</span>
                    <button
                      onClick={handleIncrement}
                      className="w-12 h-11 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all"
                      aria-label={t('common.increase_quantity')}
                    >
                      <Plus className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                  </div>
                ) : (
                  /* Add button — brand orange, always visible */
                  <button
                    onClick={handleQuickAdd}
                    className={`h-11 px-5 rounded-sm shadow-xs flex items-center justify-center gap-2 w-fit transition-all duration-500 ease-luxury active:scale-95 ${
                      isAdded
                        ? 'bg-accent-green text-white animate-add-success'
                        : 'bg-brand-500 text-white hover:bg-brand-600 hover:shadow-md'
                    }`}
                    aria-label={`${t('product.add_to_cart')} - ${title}`}
                  >
                    {isAdded ? (
                      <>
                        <Check className="w-4 h-4" strokeWidth={2.5} />
                        <span className="text-xs font-semibold">{t('product.added_short')}</span>
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4" strokeWidth={2} />
                        <span className="text-xs font-semibold">{t('common.add')}</span>
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
  )
}
