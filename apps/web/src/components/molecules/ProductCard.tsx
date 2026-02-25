'use client'

import { Badge } from '../atoms'
import Link from 'next/link'

interface ProductCardProps {
  id: string
  title: string
  imageUrl?: string | null
  price: number
  rating?: number
  tags?: string[]
  href?: string
  onAddToCart?: () => void
}

export const ProductCard = ({ id, title, imageUrl, price, rating, tags, href, onAddToCart }: ProductCardProps) => {
  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  const linkHref = href || `/products/${id}`

  return (
    <Link href={linkHref} className="group block">
      <div className="border border-slate-200 bg-white overflow-hidden hover:border-slate-300 transition-colors">
        {/* Image — 3:2 */}
        <div className="relative aspect-[3/2] overflow-hidden bg-slate-50">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={title}
              className="h-full w-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
            />
          ) : (
            <div className="absolute inset-0 bg-slate-100 flex items-center justify-center">
              <span className="text-2xl">🥩</span>
            </div>
          )}
          {rating && (
            <div className="absolute top-1 left-1 z-10 bg-white/95 text-slate-900 px-1 py-px text-[10px] font-semibold">
              {rating.toFixed(1)}
            </div>
          )}
        </div>

        {/* Body — compact */}
        <div className="px-2 py-1.5 border-t border-slate-100">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[13px] font-medium text-slate-900 leading-tight">{title}</h3>
            </div>
            <span className="flex-shrink-0 text-[13px] font-semibold text-slate-900 tabular-nums">{priceFormatted}</span>
          </div>

          <button
            className="mt-1 w-full border border-slate-200 bg-slate-50 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-colors"
            onClick={(e) => {
              e.preventDefault()
              onAddToCart?.()
            }}
          >
            Adicionar
          </button>
        </div>
      </div>
    </Link>
  )
}
