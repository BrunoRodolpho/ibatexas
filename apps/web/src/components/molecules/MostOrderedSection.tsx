'use client'

import React, { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { Plus, Minus, Check, Trash2, Flame, ChevronLeft, ChevronRight } from 'lucide-react'
import { track } from '@/domains/analytics'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { useCartStore } from '@/domains/cart'
import type { ProductDTO } from '@ibatexas/types'

interface MostOrderedSectionProps {
  products: ProductDTO[]
  onAddToCart?: (productId: string) => void
}

/**
 * "Mais Pedidos" — top sellers as single-card carousel with ranking badges.
 */
export function MostOrderedSection({ products, onAddToCart }: MostOrderedSectionProps) {
  const t = useTranslations()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  const cartItems = useCartStore((s) => s.items)
  const updateItem = useCartStore((s) => s.updateItem)
  const removeItem = useCartStore((s) => s.removeItem)

  const getCartQuantity = useCallback(
    (productId: string) =>
      cartItems.filter((item) => item.productId === productId).reduce((sum, item) => sum + item.quantity, 0),
    [cartItems],
  )
  const getCartItemId = useCallback(
    (productId: string) => cartItems.find((item) => item.productId === productId)?.id,
    [cartItems],
  )

  const handleAdd = useCallback((productId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    track('quick_add_clicked', { productId, source: 'most_ordered' })
    onAddToCart?.(productId)
    setAddedIds((prev) => new Set(prev).add(productId))
    setTimeout(() => {
      setAddedIds((prev) => {
        const next = new Set(prev)
        next.delete(productId)
        return next
      })
    }, 2000)
  }, [onAddToCart])

  const handleIncrement = useCallback((productId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const qty = getCartQuantity(productId)
    track('quantity_changed_inline', { productId, action: 'increment', quantity: qty + 1 })
    const itemId = getCartItemId(productId)
    if (itemId) updateItem(itemId, { quantity: qty + 1 })
  }, [getCartQuantity, getCartItemId, updateItem])

  const handleDecrement = useCallback((productId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const qty = getCartQuantity(productId)
    const itemId = getCartItemId(productId)
    if (qty <= 1) {
      track('quantity_changed_inline', { productId, action: 'remove', quantity: 0 })
      if (itemId) removeItem(itemId)
    } else {
      track('quantity_changed_inline', { productId, action: 'decrement', quantity: qty - 1 })
      if (itemId) updateItem(itemId, { quantity: qty - 1 })
    }
  }, [getCartQuantity, getCartItemId, updateItem, removeItem])

  if (!products || products.length === 0) return null

  const topProducts = products.slice(0, 4)
  const product = topProducts[currentIndex]
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
        <Flame className="w-5 h-5 text-brand-500" strokeWidth={2} />
        <h2 className="font-display text-display-xs font-semibold text-charcoal-900 tracking-display">
          {t('most_ordered.title')}
        </h2>
      </div>
      <p className="text-sm text-smoke-500 mb-3">
        {t('most_ordered.subtitle')}
      </p>

      {/* Single-card carousel */}
      <div className="relative mt-auto">
        <div className="surface-card rounded-card overflow-hidden group">
          <div className="flex flex-col">
            {/* Image with ranking badge */}
            <div className="relative w-full aspect-video flex-shrink-0 overflow-hidden bg-smoke-100">
              {displayImage ? (
                <>
                  <NextImage
                    src={displayImage}
                    alt={product.title}
                    fill
                    sizes="(max-width: 640px) 100vw, 50vw"
                    priority={currentIndex < 2}
                    placeholder={currentIndex < 2 ? undefined : 'blur'}
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

              {/* Ranking badge */}
              <div className="absolute top-2.5 left-2.5 z-10">
                <span className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-charcoal-900/80 backdrop-blur-sm text-xs font-bold text-smoke-50">
                  #{currentIndex + 1}
                </span>
              </div>
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
                    {cartQty > 0 ? (
                      <div className="flex items-center bg-charcoal-900 rounded-sm h-9 overflow-hidden">
                        <button
                          onClick={(e) => handleDecrement(product.id, e)}
                          className={`w-10 h-9 flex items-center justify-center hover:bg-charcoal-700 active:scale-90 transition-all ${cartQty === 1 ? 'text-accent-red' : 'text-smoke-50'}`}
                          aria-label={cartQty === 1 ? t('common.remove') : t('common.decrease_quantity')}
                        >
                          {cartQty === 1 ? <Trash2 className="w-3.5 h-3.5" strokeWidth={2.5} /> : <Minus className="w-3.5 h-3.5" strokeWidth={2.5} />}
                        </button>
                        <span className="text-xs font-bold text-smoke-50 tabular-nums min-w-[1.25rem] text-center">{cartQty}</span>
                        <button
                          onClick={(e) => handleIncrement(product.id, e)}
                          className="w-10 h-9 flex items-center justify-center text-smoke-50 hover:bg-charcoal-700 active:scale-90 transition-all"
                          aria-label={t('common.increase_quantity')}
                        >
                          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => handleAdd(product.id, e)}
                        className={`inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-sm transition-all duration-300 ease-luxury active:scale-95 ${
                          isAdded
                            ? 'bg-accent-green text-white'
                            : 'bg-brand-500 text-white hover:bg-brand-600'
                        }`}
                        aria-label={`${t('product.add_to_cart')} - ${product.title}`}
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

        {/* Navigation arrows */}
        {topProducts.length > 1 && (
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
              onClick={() => setCurrentIndex((i) => Math.min(topProducts.length - 1, i + 1))}
              disabled={currentIndex === topProducts.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 backdrop-blur-sm shadow-md flex items-center justify-center text-charcoal-900 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white transition-all"
              aria-label={t('common.next')}
            >
              <ChevronRight className="w-4 h-4" strokeWidth={2} />
            </button>
          </>
        )}
      </div>

      {/* Dot indicators */}
      {topProducts.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {topProducts.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIndex(i)}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                i === currentIndex ? 'bg-charcoal-900 w-4' : 'bg-smoke-300 hover:bg-smoke-400'
              }`}
              aria-label={`${i + 1} / ${topProducts.length}`}
            />
          ))}
        </div>
      )}
    </section>
  )
}
