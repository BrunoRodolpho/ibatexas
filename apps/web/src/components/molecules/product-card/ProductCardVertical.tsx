'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Users, Scale, Plus, Check } from 'lucide-react'
import { Badge, type BadgeProps } from '../../atoms'
import { WishlistButton } from '../WishlistButton'
import { formatBRL } from '@/lib/format'

import { ProductImage } from './ProductImage'
import { PriceBlock } from './PriceBlock'
import { QuantityControls } from './QuantityControls'
import { SocialProof } from './SocialProof'
import type { ProductCardData, CartState, CardCallbacks } from './types'

interface ProductCardVerticalProps {
  readonly data: ProductCardData
  readonly cart: CartState
  readonly callbacks: CardCallbacks
  readonly priority?: boolean
  readonly description?: string | null
  readonly variantCount?: number
  /** Pre-computed values passed from facade */
  readonly computed: {
    displayImage: string | null
    linkHref: string
    priorityTag?: string
    hasDiscount: boolean
    discountPercent: number
    priceFormatted: string
    hasMultipleVariants: boolean
    hoverImage: string | null
  }
  /** Event handlers from facade */
  readonly handlers: {
    handleQuickAdd: (e: React.MouseEvent) => void
    handleIncrement: (e: React.MouseEvent) => void
    handleDecrement: (e: React.MouseEvent) => void
    handleCardClick: () => void
  }
  readonly isAdded: boolean
}

// ── Inline: Portion scale (only used in vertical) ────────────────────────────

function PortionScale({
  servings,
  weight,
  t,
}: Readonly<{
  servings?: number
  weight?: string
  t: ReturnType<typeof useTranslations>
}>) {
  if (!servings && !weight) return null

  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
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
  )
}

// ── Inline: Priority badge (only used in vertical) ───────────────────────────

function PriorityBadge({
  isBundle,
  priorityTag,
  t,
}: Readonly<{
  isBundle?: boolean
  priorityTag?: string
  t: ReturnType<typeof useTranslations>
}>) {
  if (isBundle) {
    return (
      <div className="absolute top-2 left-2 z-10">
        <Badge variant="popular">{t('product.bundle_badge')}</Badge>
      </div>
    )
  }
  if (!priorityTag) return null
  return (
    <div className="absolute top-2 left-2 z-10">
      <Badge variant={priorityTag as BadgeProps['variant']}>
        {priorityTag.replaceAll("_", " ")}
      </Badge>
    </div>
  )
}

// ── Inline: Availability window label (only used in vertical) ────────────────

function AvailabilityLabel({
  availabilityWindow,
  t,
}: Readonly<{
  availabilityWindow?: string
  t: ReturnType<typeof useTranslations>
}>) {
  if (availabilityWindow !== 'ALMOCO' && availabilityWindow !== 'JANTAR') return null
  return (
    <p className="mt-1 text-xs text-amber-600 font-medium">
      {availabilityWindow === 'ALMOCO' ? t('product.available_almoco_short') : t('product.available_jantar_short')}
    </p>
  )
}

// ── Inline: Add-to-cart CTA button (only used in vertical) ───────────────────

function AddToCartButton({
  isAdded,
  title,
  onQuickAdd,
  t,
}: Readonly<{
  isAdded: boolean
  title: string
  onQuickAdd: (e: React.MouseEvent) => void
  t: ReturnType<typeof useTranslations>
}>) {
  const stateClass = isAdded
    ? 'bg-accent-green text-white animate-add-success'
    : 'bg-brand-500 text-white hover:bg-brand-600 shadow-xs hover:shadow-md'

  return (
    <button
      onClick={onQuickAdd}
      className={`w-full h-10 flex items-center justify-center gap-1.5 rounded-sm text-xs font-semibold transition-all duration-500 ease-luxury active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${stateClass}`}
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
  )
}

export function ProductCardVertical({
  data,
  cart,
  callbacks,
  priority,
  description,
  variantCount: _variantCount,
  computed,
  handlers,
  isAdded,
}: ProductCardVerticalProps) {
  const t = useTranslations()

  return (
    <div className="group relative h-full">
      <div className="surface-card rounded-card overflow-hidden transition-premium group-hover:shadow-card-hover group-hover:-translate-y-0.5 h-full flex flex-col">
        {/* Image -- 4:3 portrait, editorial food ratio */}
        <div className="relative aspect-[4/3] overflow-hidden bg-smoke-100 warm-hover-glow">
          <ProductImage
            displayImage={computed.displayImage}
            title={data.title}
            priority={priority}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            hoverImage={computed.hoverImage}
            scaleOnHover
          />

          {/* Hover gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal-900/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury pointer-events-none" />

          {/* Single priority badge -- top left */}
          <PriorityBadge isBundle={data.isBundle} priorityTag={computed.priorityTag} t={t} />

          {/* Wishlist heart -- top right */}
          <div className="absolute top-2 right-2 z-10">
            <WishlistButton productId={data.id} size="sm" />
          </div>

          {/* Scarcity indicator */}
          {data.stockCount != null && data.stockCount > 0 && data.stockCount <= 5 && (
            <div className="absolute top-12 right-2 z-10 bg-accent-red/90 text-white text-micro font-semibold px-2 py-0.5 rounded-sm">
              {t('scarcity', { count: data.stockCount })}
            </div>
          )}
        </div>

        {/* Details -- below image */}
        <div className="pt-3 pb-3 px-3 flex-1 flex flex-col min-h-[160px]">
          <h3 className="font-display text-display-2xs tracking-display text-charcoal-900 leading-snug line-clamp-2 group-hover:text-charcoal-700 transition-micro">
            <Link href={computed.linkHref} className="after:absolute after:inset-0 after:content-['']" onClick={handlers.handleCardClick}>
              {data.title}
            </Link>
          </h3>

          {/* Subtitle */}
          {data.subtitle && (
            <p className="mt-1 text-xs text-smoke-500 line-clamp-1">{data.subtitle}</p>
          )}

          {/* Portion scale -- servings + weight */}
          {!data.subtitle && (data.servings || data.weight) && (
            <PortionScale servings={data.servings} weight={data.weight} t={t} />
          )}

          {/* Description -- 2 line clamp */}
          {description && !data.subtitle && (
            <p className="mt-1 text-xs text-[var(--color-text-secondary)] line-clamp-2">{description}</p>
          )}

          {/* Availability window */}
          <AvailabilityLabel availabilityWindow={data.availabilityWindow} t={t} />

          {/* Social proof -- star rating + order count + scarcity */}
          <SocialProof
            rating={data.rating}
            reviewCount={data.reviewCount}
            tags={data.tags}
            ordersToday={data.ordersToday}
            t={t}
          />

          {/* Price block */}
          <PriceBlock
            price={data.price}
            priceFormatted={computed.priceFormatted}
            compareAtPrice={data.compareAtPrice}
            hasDiscount={computed.hasDiscount}
            discountPercent={computed.discountPercent}
            hasMultipleVariants={computed.hasMultipleVariants}
            t={t}
          />
          {data.isBundle && data.bundleServings && data.bundleServings > 1 && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              {t('product.per_person_short', { price: formatBRL(Math.round(data.price / data.bundleServings)) })}
            </p>
          )}

          {/* CTA -- always visible, orange primary action */}
          {callbacks.onAddToCart && (
            <div className="relative z-10 pt-3">
              {cart.quantity > 0 && callbacks.onUpdateQuantity ? (
                <QuantityControls cartQuantity={cart.quantity} onDecrement={handlers.handleDecrement} onIncrement={handlers.handleIncrement} size="md" t={t} />
              ) : (
                <AddToCartButton isAdded={isAdded} title={data.title} onQuickAdd={handlers.handleQuickAdd} t={t} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
