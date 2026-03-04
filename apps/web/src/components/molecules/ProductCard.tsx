'use client'

import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { Plus, Star } from 'lucide-react'
import { Badge } from '../atoms/Badge'
import { track } from '@/lib/analytics'

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
}: ProductCardProps) => {
  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
  const hasMultipleVariants = (variantCount ?? 0) > 1

  // Prefer thumbnail, fall back to first gallery image
  const displayImage = imageUrl || images?.[0] || null
  const linkHref = href || `/products/${id}`

  const handleQuickAdd = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId: id, source: 'listing' })
    onAddToCart?.()
  }

  const handleCardClick = () => {
    track('product_card_clicked', { productId: id, source: 'listing' })
  }

  const displayTags = tags?.slice(0, 2) ?? []
  const showRating = rating && rating >= 4.0

  return (
    <Link href={linkHref} className="group block" onClick={handleCardClick}>
      <div className="overflow-hidden">
        {/* Image — 4:5 portrait, editorial food ratio */}
        <div className="relative aspect-[4/5] overflow-hidden rounded-sm bg-smoke-100">
          {displayImage ? (
            <NextImage
              src={displayImage}
              alt={title}
              fill
              sizes="(max-width: 768px) 50vw, 33vw"
              className="object-cover group-hover:scale-[1.02] transition-transform duration-800 ease-luxury"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
              <span className="font-display text-sm font-medium text-smoke-300/40 uppercase tracking-editorial">IbateXas</span>
            </div>
          )}

          {/* Hover gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal-900/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-luxury pointer-events-none" />

          {/* Tag badges — top left */}
          {displayTags.length > 0 && (
            <div className="absolute top-2 left-2 z-10 flex gap-1">
              {displayTags.map((tag) => (
                <Badge key={tag} variant={(tag as any) || 'default'}>
                  {tag}
                </Badge>
              ))}
            </div>
          )}

          {/* Rating badge — top left, below tags */}
          {showRating && (
            <div className="absolute top-2 left-2 z-10 bg-smoke-50/90 backdrop-blur-sm text-charcoal-900 px-1.5 py-0.5 text-[10px] font-medium inline-flex items-center gap-0.5" style={{ top: displayTags.length > 0 ? '2.25rem' : '0.5rem' }}>
              <Star className="w-2.5 h-2.5 fill-brand-500 text-brand-500" />
              {rating.toFixed(1)}
              {reviewCount ? <span className="text-smoke-400 ml-0.5">({reviewCount})</span> : null}
            </div>
          )}

          {/* Quick-add button */}
          {onAddToCart && (
            <button
              onClick={handleQuickAdd}
              className="absolute bottom-2 right-2 z-10 bg-charcoal-900 text-smoke-50 w-8 h-8 lg:w-10 lg:h-10 rounded-full shadow-md flex items-center justify-center opacity-100 lg:opacity-0 lg:translate-y-2 lg:group-hover:opacity-100 lg:group-hover:translate-y-0 transition-all duration-500 ease-luxury hover:bg-charcoal-700 active:scale-95"
              aria-label={`Adicionar ${title} ao carrinho`}
            >
              <Plus className="w-4 h-4 lg:w-5 lg:h-5" strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Details — minimal, below image */}
        <div className="pt-4 pb-1">
          <h3 className="text-sm font-medium text-charcoal-900 leading-snug group-hover:text-charcoal-700 transition-colors duration-500 ease-luxury">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-smoke-400 line-clamp-1">{subtitle}</p>
          )}

          {/* Weight / servings info */}
          {(weight || servings) && (
            <p className="mt-0.5 text-xs text-smoke-300">
              {weight}{weight && servings ? ' · ' : ''}{servings ? `Serve ${servings}` : ''}
            </p>
          )}

          <p className="mt-1.5 text-sm text-smoke-400 tabular-nums">
            {hasMultipleVariants && (
              <span className="text-xs text-smoke-300 mr-1">a partir de</span>
            )}
            {compareAtPrice && compareAtPrice > price && (
              <span className="text-xs text-smoke-300 line-through mr-1.5">
                {(compareAtPrice / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </span>
            )}
            {priceFormatted}
          </p>
        </div>
      </div>
    </Link>
  )
}
