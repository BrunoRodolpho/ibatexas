'use client'

import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Minus, Check, Star, Users, Scale, Flame, Trash2 } from 'lucide-react'
import { Badge, type BadgeProps } from '../atoms/Badge'
import { track } from '@/domains/analytics'
import { useState, useCallback } from 'react'

import { BLUR_PLACEHOLDER } from '@/lib/constants'

/** Badge priority order — first match wins (only 1 badge shown) */
const BADGE_PRIORITY = ['edicao_limitada', 'chef_choice', 'popular', 'novo'] as const

interface ProductCardProps {
  readonly id: string
  readonly title: string
  readonly subtitle?: string
  readonly imageUrl?: string | null
  readonly images?: string[]
  readonly price: number
  readonly compareAtPrice?: number
  readonly variantCount?: number
  readonly rating?: number
  readonly reviewCount?: number
  readonly tags?: string[]
  readonly weight?: string
  readonly servings?: number
  readonly stockCount?: number
  readonly availabilityWindow?: string
  readonly description?: string | null
  readonly isBundle?: boolean
  readonly bundleServings?: number
  readonly href?: string
  readonly onAddToCart?: () => void
  readonly priority?: boolean
  /** Current quantity in cart (0 or undefined = not in cart) */
  readonly cartQuantity?: number
  /** Callback to update quantity in cart */
  readonly onUpdateQuantity?: (qty: number) => void
  /** Callback to remove item from cart */
  readonly onRemoveFromCart?: () => void
  /** Number of orders today — shown as scarcity signal when >= 5 */
  readonly ordersToday?: number
  /** Card layout variant */
  readonly variant?: 'vertical' | 'horizontal'
}

export const ProductCard = ({
  id,
  title,
  subtitle,
  imageUrl,
  images,
  price,
  compareAtPrice,
  variantCount,
  rating,
  reviewCount,
  tags,
  weight,
  servings,
  stockCount,
  availabilityWindow,
  description,
  isBundle,
  bundleServings,
  href,
  onAddToCart,
  priority,
  cartQuantity = 0,
  onUpdateQuantity,
  onRemoveFromCart,
  ordersToday,
  variant = 'vertical',
}: ProductCardProps) => {
  const t = useTranslations()
  const [isAdded, setIsAdded] = useState(false)

  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
  const hasMultipleVariants = (variantCount ?? 0) > 1

  // Prefer thumbnail, fall back to first gallery image
  const displayImage = imageUrl || images?.[0] || null
  const linkHref = href || `/products/${id}`

  // Single priority badge (first match wins)
  const priorityTag = tags?.find((tag) =>
    BADGE_PRIORITY.includes(tag as (typeof BADGE_PRIORITY)[number])
  )

  // Social proof only when meaningful (≥ 4 AND ≥ 10 reviews)
  const showSocialProof = rating && rating >= 4 && reviewCount && reviewCount >= 10

  // Discount percentage for non-premium items
  const hasDiscount = compareAtPrice && compareAtPrice > price
  const discountPercent = hasDiscount
    ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
    : 0

  const handleQuickAdd = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId: id, source: 'listing' })
    onAddToCart?.()

    // Visual feedback: animate then show success state
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
    track('product_card_clicked', { productId: id, source: 'listing' })
  }

  // ── Horizontal card variant ──────────────────────────────────────
  if (variant === 'horizontal') {
    return (
      <div className="group relative">
        <div className="surface-card rounded-card overflow-hidden transition-all duration-500 ease-luxury group-hover:shadow-card-hover">
          <div className="flex flex-row">
            {/* Square thumbnail */}
            <div className="relative w-28 h-28 flex-shrink-0 overflow-hidden bg-smoke-100">
              {displayImage ? (
                <>
                  <NextImage
                    src={displayImage}
                    alt={title}
                    fill
                    sizes="112px"
                    priority={priority}
                    placeholder={priority ? undefined : 'blur'}
                    blurDataURL={BLUR_PLACEHOLDER}
                    className="object-cover contrast-[1.08]"
                  />
                  <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
                </>
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 grain-overlay flex items-center justify-center">
                  <span className="font-display text-[8px] tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 py-2 px-3 flex items-center">
              <div className="flex-1 min-w-0">
                <h3 className="font-display text-sm font-medium text-charcoal-900 leading-snug truncate">
                  <Link href={linkHref} className="after:absolute after:inset-0 after:content-['']" onClick={handleCardClick}>
                    {title}
                  </Link>
                </h3>
                {subtitle && (
                  <p className="mt-0.5 text-xs text-smoke-500 truncate">{subtitle}</p>
                )}
                <span className="mt-1 block text-sm font-semibold tabular-nums text-charcoal-900">
                  {priceFormatted}
                </span>
              </div>

              {/* Inline add / quantity */}
              {onAddToCart && (
                <div className="relative z-10 flex-shrink-0 ml-2">
                  {cartQuantity > 0 && onUpdateQuantity ? (
                    <div className="flex items-center gap-0 bg-charcoal-900 rounded-full h-9 overflow-hidden">
                      <button onClick={handleDecrement} className={`w-9 h-9 flex items-center justify-center hover:bg-charcoal-700 active:scale-90 transition-all ${cartQuantity === 1 ? 'text-accent-red' : 'text-smoke-50'}`} aria-label={cartQuantity === 1 ? t('common.remove') : t('common.decrease_quantity')}>
                        {cartQuantity === 1 ? <Trash2 className="w-3.5 h-3.5" strokeWidth={2.5} /> : <Minus className="w-3.5 h-3.5" strokeWidth={2.5} />}
                      </button>
                      <span className="text-xs font-bold text-smoke-50 tabular-nums min-w-[1.25rem] text-center">{cartQuantity}</span>
                      <button onClick={handleIncrement} className="w-9 h-9 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all" aria-label={t('common.increase_quantity')}>
                        <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleQuickAdd}
                      className="w-9 h-9 rounded-full bg-brand-500 text-white flex items-center justify-center shadow-md hover:bg-brand-600 active:scale-90 transition-all duration-300 ease-luxury"
                      aria-label={`${t('product.add_to_cart')} - ${title}`}
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

  // ── Vertical card variant (default) ──────────────────────────────
  return (
    <div className="group relative h-full">
      <div className="surface-card rounded-card overflow-hidden transition-all duration-500 ease-luxury group-hover:shadow-card-hover group-hover:-translate-y-1 h-full flex flex-col">
        {/* Image — 4:5 portrait, editorial food ratio */}
        <div className="relative aspect-[4/3] overflow-hidden bg-smoke-100">
          {displayImage ? (
            <>
              <NextImage
                src={displayImage}
                alt={title}
                fill
                priority={priority}
                placeholder={priority ? undefined : 'blur'}
                blurDataURL={BLUR_PLACEHOLDER}
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                className="object-cover contrast-[1.08] group-hover:scale-[1.04] transition-transform duration-800 ease-luxury"
              />
              {/* Secondary image on hover */}
              {images && images.length >= 2 && images[1] !== displayImage && (
                <NextImage
                  src={images[1]}
                  alt={`${title} — alternativa`}
                  fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                  className="object-cover contrast-[1.08] absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury"
                />
              )}
              {/* Warm overlay — unifies product photos shot in different lighting */}
              <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 grain-overlay flex items-center justify-center">
              <span className="font-display text-xs tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
            </div>
          )}

          {/* Hover gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal-900/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury pointer-events-none" />

          {/* Single priority badge — top left */}
          {isBundle ? (
            <div className="absolute top-2 left-2 z-10">
              <Badge variant="popular">{t('product.bundle_badge')}</Badge>
            </div>
          ) : priorityTag && (
            <div className="absolute top-2 left-2 z-10">
              <Badge variant={priorityTag as BadgeProps['variant']}>
                {priorityTag.replaceAll("_", " ")}
              </Badge>
            </div>
          )}

          {/* Scarcity indicator */}
          {stockCount != null && stockCount > 0 && stockCount <= 5 && (
            <div className="absolute top-2 right-2 z-10 bg-accent-red/90 text-white text-[10px] font-semibold px-2 py-0.5 rounded-sm">
              {t('scarcity', { count: stockCount })}
            </div>
          )}
        </div>

        {/* Details — below image */}
        <div className="pt-3 pb-3 px-3 flex-1 flex flex-col min-h-[160px]">
          <h3 className="font-display text-display-2xs tracking-display text-charcoal-900 leading-snug line-clamp-2 group-hover:text-charcoal-700 transition-colors duration-500 ease-luxury">
            <Link href={linkHref} className="after:absolute after:inset-0 after:content-['']" onClick={handleCardClick}>
              {title}
            </Link>
          </h3>

          {/* Subtitle */}
          {subtitle && (
            <p className="mt-1 text-xs text-smoke-500 line-clamp-1">{subtitle}</p>
          )}

          {/* Portion scale — servings + weight */}
          {!subtitle && (servings || weight) && (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-smoke-400">
              {servings && (
                <span className="inline-flex items-center gap-0.5">
                  <Users className="w-3 h-3" />
                  {t('product.serves', { count: servings })}
                </span>
              )}
              {servings && weight && <span>·</span>}
              {weight && (
                <span className="inline-flex items-center gap-0.5">
                  <Scale className="w-3 h-3" />
                  {weight}
                </span>
              )}
            </div>
          )}

          {/* Description — 2 line clamp */}
          {description && !subtitle && (
            <p className="mt-1 text-xs text-smoke-400 line-clamp-2">{description}</p>
          )}

          {/* Availability window */}
          {availabilityWindow && (availabilityWindow === 'ALMOCO' || availabilityWindow === 'JANTAR') && (
            <p className="mt-1 text-[11px] text-amber-600 font-medium">
              {availabilityWindow === 'ALMOCO' ? t('product.available_almoco_short') : t('product.available_jantar_short')}
            </p>
          )}

          {/* Social proof — star rating + order count */}
          {showSocialProof && (
            <div className="mt-1.5 inline-flex items-center gap-1">
              <Star className="w-3 h-3 fill-brand-500 text-brand-500" />
              <span className="text-[11px] text-charcoal-900 font-medium tabular-nums">
                {rating.toFixed(1)}
              </span>
              <span className="text-[11px] text-smoke-400">({reviewCount})</span>
            </div>
          )}
          {tags?.includes('popular') && reviewCount && reviewCount > 50 && (
            <p className="text-[11px] text-smoke-400">{t('product.ordered_count', { count: reviewCount })}</p>
          )}

          {/* Scarcity / popularity signal */}
          {ordersToday != null && ordersToday >= 5 && (
            <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 font-medium">
              <Flame className="w-3 h-3" strokeWidth={2} />
              {t('product.orders_today', { count: ordersToday })}
            </p>
          )}

          {/* Price block */}
          <div className="mt-auto pt-2 flex items-baseline gap-1.5">
            {hasMultipleVariants && (
              <span className="text-[10px] text-smoke-400">{t('product.from_price')}</span>
            )}
            {hasDiscount && (
              <span className="text-xs text-smoke-300 line-through">
                {(compareAtPrice / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </span>
            )}
            <span className="text-lg font-semibold tracking-tight text-charcoal-900 tabular-nums">
              {priceFormatted}
            </span>
            {hasDiscount && discountPercent > 0 && price < 15000 && (
              <span className="text-xs text-accent-green font-medium">-{discountPercent}%</span>
            )}
          </div>
          {isBundle && bundleServings && bundleServings > 1 && (
            <p className="text-[11px] text-smoke-400">
              {t('product.per_person_short', { price: (price / bundleServings / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) })}
            </p>
          )}

          {/* CTA — always visible, orange primary action */}
          {onAddToCart && (
            <div className="relative z-10 pt-3">
              {cartQuantity > 0 && onUpdateQuantity ? (
                /* Quantity controls — shown when item is in cart */
                <div className="flex items-center justify-between bg-charcoal-900 rounded-sm h-10 overflow-hidden">
                  <button
                    onClick={handleDecrement}
                    className={`w-12 h-10 flex items-center justify-center hover:bg-charcoal-700 active:scale-90 transition-all focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${cartQuantity === 1 ? 'text-accent-red' : 'text-smoke-50'}`}
                    aria-label={cartQuantity === 1 ? t('common.remove') : t('common.decrease_quantity')}
                  >
                    {cartQuantity === 1 ? <Trash2 className="w-4 h-4" strokeWidth={2.5} /> : <Minus className="w-4 h-4" strokeWidth={2.5} />}
                  </button>
                  <span className="text-sm font-bold text-smoke-50 tabular-nums" aria-live="polite">{cartQuantity}</span>
                  <button
                    onClick={handleIncrement}
                    className="w-12 h-10 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
                    aria-label={t('common.increase_quantity')}
                  >
                    <Plus className="w-4 h-4" strokeWidth={2.5} />
                  </button>
                </div>
              ) : (
                /* Add button — brand orange, always visible */
                <button
                  onClick={handleQuickAdd}
                  className={`w-full h-10 flex items-center justify-center gap-1.5 rounded-sm text-xs font-semibold transition-all duration-500 ease-luxury active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
                    isAdded
                      ? 'bg-accent-green text-white animate-add-success'
                      : 'bg-brand-500 text-white hover:bg-brand-600 shadow-xs hover:shadow-md'
                  }`}
                  aria-label={`${t('product.add_to_cart')} - ${title}`}
                >
                  {isAdded ? (
                    <>
                      <Check className="w-4 h-4" strokeWidth={2.5} />
                      <span>{t('product.added_short')}</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" strokeWidth={2} />
                      <span>{t('common.add')}</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
