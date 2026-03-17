'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { TrendingUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { useQuickCartActions } from '@/domains/cart/useQuickCartActions'
import { CartActionButton } from './CartActionButton'
import type { ProductDTO } from '@ibatexas/types'

interface GuidedSectionProps {
  readonly title: string
  readonly subtitle?: string
  readonly products: ProductDTO[]
  readonly onAddToCart?: (productId: string) => void
}

/**
 * "Em Alta" — trending products as single-card carousel with pagination.
 */
export function GuidedSection({ title, subtitle, products, onAddToCart }: GuidedSectionProps) {
  const t = useTranslations()
  const [currentIndex, setCurrentIndex] = useState(0)
  const { addedIds, getCartQuantity, handleAdd, handleIncrement, handleDecrement } =
    useQuickCartActions(onAddToCart, 'em_alta')

  if (products.length === 0) return null

  const featured = products.slice(0, 4)
  const product = featured[currentIndex]
  if (!product) return null

  const priceFormatted = (product.price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
  const displayImage = product.imageUrl || product.images?.[0] || null
  const isAdded = addedIds.has(product.id)
  const cartQty = getCartQuantity(product.id)

  return (
    <section className="flex flex-col h-full">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp className="w-5 h-5 text-brand-500" strokeWidth={2} />
        <h2 className="font-display text-display-xs font-semibold text-charcoal-900 tracking-display">
          {title}
        </h2>
      </div>
      {subtitle && (
        <p className="text-sm text-smoke-500 mb-3">{subtitle}</p>
      )}

      {/* Single-card carousel */}
      <div className="relative mt-auto">
        <div className="surface-card rounded-card overflow-hidden group">
          <div className="flex flex-col">
            {/* Image */}
            <div className="relative w-full aspect-video flex-shrink-0 overflow-hidden bg-smoke-100">
              {displayImage ? (
                <>
                  <NextImage
                    src={displayImage}
                    alt={product.title}
                    fill
                    sizes="(max-width: 640px) 100vw, 50vw"
                    placeholder="blur"
                    blurDataURL={BLUR_PLACEHOLDER}
                    className="object-cover contrast-[1.08] group-hover:scale-[1.03] transition-transform duration-800 ease-luxury"
                  />
                  <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
                </>
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center">
                  <span className="font-display text-xs tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 p-4 flex flex-col justify-center">
              <h3 className="font-display text-display-2xs font-semibold text-charcoal-900 tracking-display mb-1">
                <Link href={`/loja/produto/${product.id}`}>
                  {product.title}
                </Link>
              </h3>
              {product.description && (
                <p className="text-sm text-smoke-500 mb-3 font-display italic line-clamp-2">
                  {product.description}
                </p>
              )}

              {/* Price + CTA */}
              <div className="flex items-center justify-between mt-auto">
                <span className="text-lg font-semibold tabular-nums text-charcoal-900">
                  {priceFormatted}
                </span>
                {onAddToCart && (
                  <div className="relative z-10">
                    <CartActionButton
                      productId={product.id}
                      productTitle={product.title}
                      cartQty={cartQty}
                      isAdded={isAdded}
                      onAdd={handleAdd}
                      onIncrement={handleIncrement}
                      onDecrement={handleDecrement}
                      t={t}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Navigation arrows */}
        {featured.length > 1 && (
          <>
            <button
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 backdrop-blur-sm shadow-md flex items-center justify-center text-charcoal-900 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white transition-all"
              aria-label={t('common.previous')}
            >
              <ChevronLeft className="w-4 h-4" strokeWidth={2} />
            </button>
            <button
              onClick={() => setCurrentIndex((i) => Math.min(featured.length - 1, i + 1))}
              disabled={currentIndex === featured.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 backdrop-blur-sm shadow-md flex items-center justify-center text-charcoal-900 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white transition-all"
              aria-label={t('common.next')}
            >
              <ChevronRight className="w-4 h-4" strokeWidth={2} />
            </button>
          </>
        )}
      </div>

      {/* Dot indicators */}
      {featured.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {featured.map((p, i) => (
            <button
              key={`dot-${p.id}`}
              onClick={() => setCurrentIndex(i)}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                i === currentIndex ? 'bg-charcoal-900 w-4' : 'bg-smoke-300 hover:bg-smoke-400'
              }`}
              aria-label={`${i + 1} / ${featured.length}`}
            />
          ))}
        </div>
      )}
    </section>
  )
}
