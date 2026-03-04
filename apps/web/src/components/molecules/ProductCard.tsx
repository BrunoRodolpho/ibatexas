'use client'

import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Star } from 'lucide-react'
import { Badge, type BadgeProps } from '../atoms/Badge'
import { track } from '@/lib/analytics'

import { BLUR_PLACEHOLDER } from '@/lib/constants'

/** Badge priority order — first match wins (only 1 badge shown) */
const BADGE_PRIORITY = ['edicao_limitada', 'exclusivo', 'chef_choice', 'popular', 'novo'] as const

interface ProductCardProps {
  id: string
  title: string
  subtitle?: string
  imageUrl?: string | null
  images?: string[]
  price: number
  compareAtPrice?: number
  variantCount?: number
  rating?: number
  reviewCount?: number
  tags?: string[]
  weight?: string
  servings?: number
  href?: string
  onAddToCart?: () => void
  priority?: boolean
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
  href,
  onAddToCart,
  priority,
}: ProductCardProps) => {
  const t = useTranslations()
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

  // Social proof only when meaningful (≥ 4.0 AND ≥ 10 reviews)
  const showSocialProof = rating && rating >= 4.0 && reviewCount && reviewCount >= 10

  // Discount percentage for non-premium items
  const hasDiscount = compareAtPrice && compareAtPrice > price
  const discountPercent = hasDiscount
    ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
    : 0

  const handleQuickAdd = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId: id, source: 'listing' })
    onAddToCart?.()
  }

  const handleCardClick = () => {
    track('product_card_clicked', { productId: id, source: 'listing' })
  }

  return (
    <div className="group relative">
      <div className="overflow-hidden transition-all duration-500 ease-luxury group-hover:translate-y-[-2px] group-hover:shadow-card">
        {/* Image — 4:5 portrait, editorial food ratio */}
        <div className="relative aspect-[4/5] overflow-hidden rounded-card bg-smoke-100">
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
                className="object-cover contrast-[1.08] group-hover:scale-[1.03] transition-transform duration-800 ease-luxury"
              />
              {/* Warm overlay — unifies product photos shot in different lighting */}
              <div className="absolute inset-0 bg-brand-50/10 mix-blend-multiply pointer-events-none" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
              <span className="font-display text-sm font-medium text-smoke-300/40 uppercase tracking-editorial">IbateXas</span>
            </div>
          )}

          {/* Hover gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal-900/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury pointer-events-none" />

          {/* Single priority badge — top left */}
          {priorityTag && (
            <div className="absolute top-2 left-2 z-10">
              <Badge variant={priorityTag as BadgeProps['variant']}>
                {priorityTag.replace(/_/g, ' ')}
              </Badge>
            </div>
          )}

          {/* Quick-add button — OUTSIDE link hierarchy, z-index above stretched link */}
          {onAddToCart && (
            <button
              onClick={handleQuickAdd}
              className="absolute bottom-2 right-2 z-10 bg-charcoal-900 text-smoke-50 h-11 px-3 rounded-sm shadow-md flex items-center justify-center gap-1.5 opacity-100 lg:opacity-0 lg:translate-y-2 lg:group-hover:opacity-100 lg:group-hover:translate-y-0 transition-all duration-500 ease-luxury hover:bg-charcoal-700 active:scale-95"
              aria-label={`${t('product.add_to_cart')} - ${title}`}
            >
              <Plus className="w-4 h-4" strokeWidth={2} />
              <span className="hidden lg:group-hover:inline text-xs font-medium">{t('common.add')}</span>
            </button>
          )}
        </div>

        {/* Details — minimal, below image */}
        <div className="pt-3 pb-1">
          <h3 className="font-display text-sm font-medium text-charcoal-900 leading-snug group-hover:text-charcoal-700 transition-colors duration-500 ease-luxury">
            <Link href={linkHref} className="after:absolute after:inset-0 after:content-['']" onClick={handleCardClick}>
              {title}
            </Link>
          </h3>

          {/* Subtitle / weight+servings merged */}
          {(subtitle || weight || servings) && (
            <p className="mt-0.5 text-xs text-smoke-400">
              {subtitle || [weight, servings ? `Serve ${servings}` : ''].filter(Boolean).join(' · ')}
            </p>
          )}

          {/* Price block */}
          <p className="mt-1.5 text-sm tabular-nums">
            {hasMultipleVariants && (
              <span className="text-xs text-smoke-400 mr-1">a partir de</span>
            )}
            {hasDiscount && (
              <span className="text-xs text-smoke-300 line-through mr-1.5">
                {(compareAtPrice / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </span>
            )}
            <span className="font-semibold text-charcoal-900">{priceFormatted}</span>
            {hasDiscount && discountPercent > 0 && price < 15000 && (
              <span className="text-xs text-brand-600 font-medium ml-1.5">-{discountPercent}%</span>
            )}
          </p>

          {/* Social proof — only if meaningful */}
          {showSocialProof && (
            <p className="mt-1 text-[10px] text-smoke-400 inline-flex items-center gap-0.5">
              <Star className="w-2.5 h-2.5 fill-brand-500 text-brand-500" />
              {rating.toFixed(1)}
              <span className="ml-0.5">({reviewCount})</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
