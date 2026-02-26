'use client'

import Link from 'next/link'

interface ProductCardProps {
  id: string
  title: string
  subtitle?: string
  imageUrl?: string | null
  price: number
  rating?: number
  tags?: string[]
  href?: string
  onAddToCart?: () => void
}

export const ProductCard = ({ id, title, subtitle, imageUrl, price, rating, tags, href }: ProductCardProps) => {
  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  const linkHref = href || `/products/${id}`

  return (
    <Link href={linkHref} className="group block">
      <div className="overflow-hidden">
        {/* Image — 4:5 portrait, editorial food ratio */}
        <div className="relative aspect-[4/5] overflow-hidden rounded-sm bg-smoke-100">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={title}
              className="h-full w-full object-cover group-hover:scale-[1.02] transition-transform duration-800 ease-luxury"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
              <span className="font-display text-sm font-medium text-smoke-300/40 uppercase tracking-editorial">IbateXas</span>
            </div>
          )}
          {rating && (
            <div className="absolute top-2 left-2 z-10 bg-smoke-50/90 backdrop-blur-sm text-charcoal-900 px-1.5 py-0.5 text-[10px] font-medium">
              {rating.toFixed(1)}
            </div>
          )}
        </div>

        {/* Details — minimal, below image */}
        <div className="pt-4 pb-1">
          <h3 className="text-sm font-medium text-charcoal-900 leading-snug group-hover:text-charcoal-700 transition-colors duration-500 ease-luxury">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-smoke-400 line-clamp-1">{subtitle}</p>
          )}
          <p className="mt-1.5 text-sm text-smoke-400 tabular-nums">{priceFormatted}</p>
        </div>
      </div>
    </Link>
  )
}
