'use client'

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import NextImage from 'next/image'
import { Plus, Check, Star } from 'lucide-react'
import { trackOnceVisible } from '@/domains/analytics'
import { useCartStore } from '@/domains/cart/cart.store'
import { CROSS_SELL_MAP } from '@/domains/product/cross-sell'
import { track } from '@/domains/analytics'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import type { ProductDTO } from '@ibatexas/types'

interface PeopleAlsoOrderedProps {
  /** Full product list to pick suggestions from */
  allProducts: ProductDTO[]
  /** Add to cart handler (productId) */
  onAddToCart: (productId: string) => void
}

/**
 * Cross-sell section on the menu/search page.
 * Shows complementary products based on what's currently in the cart.
 */
export function PeopleAlsoOrdered({ allProducts, onAddToCart }: PeopleAlsoOrderedProps) {
  const t = useTranslations()
  const cartItems = useCartStore((s) => s.items)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())
  const sectionRef = useRef<HTMLElement>(null)

  const handleAdd = useCallback((productId: string) => {
    track('people_also_ordered_added', { productId })
    onAddToCart(productId)
    setAddedIds((prev) => new Set(prev).add(productId))
    setTimeout(() => {
      setAddedIds((prev) => {
        const next = new Set(prev)
        next.delete(productId)
        return next
      })
    }, 2000)
  }, [onAddToCart])

  const suggestions = useMemo(() => {
    if (cartItems.length === 0 || allProducts.length === 0) return []

    // Collect cross-sell categories from items in cart
    const cartProductIds = new Set(cartItems.map((item) => item.productId))
    const crossCategories = new Set<string>()

    for (const item of cartItems) {
      // Find the product to get its category
      const product = allProducts.find((p) => p.id === item.productId)
      if (product?.categoryHandle) {
        const paired = CROSS_SELL_MAP[product.categoryHandle]
        paired?.forEach((cat) => crossCategories.add(cat))
      }
    }

    // Find products in those categories that aren't already in cart
    return allProducts
      .filter(
        (p) =>
          p.categoryHandle &&
          crossCategories.has(p.categoryHandle) &&
          !cartProductIds.has(p.id),
      )
      .slice(0, 4)
  }, [cartItems, allProducts])

  // Track section visibility for analytics
  useEffect(() => {
    if (sectionRef.current && suggestions.length > 0) {
      trackOnceVisible(sectionRef.current, 'cross_sell_viewed', {
        source: 'people_also_ordered',
        count: suggestions.length,
      })
    }
  }, [suggestions.length])

  if (suggestions.length === 0) return null

  return (
    <section ref={sectionRef} className="mb-8">
      <div className="mb-4">
        <h3 className="font-display text-display-2xs font-semibold text-charcoal-900 tracking-display">
          {t('people_also_ordered.title')}
        </h3>
        <p className="mt-1 text-xs text-smoke-400">
          {t('people_also_ordered.subtitle')}
        </p>
      </div>

      <div className="flex gap-3 overflow-x-auto scrollbar-hide snap-x snap-mandatory -mx-4 px-4 sm:mx-0 sm:px-0 pb-2">
        {suggestions.map((product) => {
          const priceFormatted = (product.price / 100).toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL',
          })
          const displayImage = product.imageUrl || product.images?.[0]

          return (
            <div
              key={product.id}
              className="snap-start flex-shrink-0 w-[180px] sm:w-[200px]"
            >
              <div className="surface-card rounded-card overflow-hidden">
                {/* Thumbnail */}
                <div className="relative aspect-square overflow-hidden bg-smoke-100">
                  {displayImage ? (
                    <NextImage
                      src={displayImage}
                      alt={product.title}
                      fill
                      sizes="200px"
                      placeholder="blur"
                      blurDataURL={BLUR_PLACEHOLDER}
                      className="object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-smoke-100 flex items-center justify-center">
                      <span className="text-smoke-300 text-[8px] uppercase tracking-widest">IbateXas</span>
                    </div>
                  )}
                </div>

                {/* Info + CTA */}
                <div className="p-3">
                  <h4 className="text-sm font-medium text-charcoal-900 truncate">
                    {product.title}
                  </h4>
                  {product.rating && product.rating >= 4.0 && product.reviewCount && product.reviewCount >= 10 && (
                    <div className="flex items-center gap-0.5 mt-0.5">
                      <Star className="w-3 h-3 fill-brand-500 text-brand-500" />
                      <span className="text-[11px] text-charcoal-900 font-medium tabular-nums">{product.rating.toFixed(1)}</span>
                    </div>
                  )}
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-charcoal-900">
                    {priceFormatted}
                  </p>
                  <button
                    onClick={() => handleAdd(product.id)}
                    className={`mt-2 w-full h-8 flex items-center justify-center gap-1 text-xs font-medium rounded-sm transition-all duration-300 ease-luxury active:scale-95 ${
                      addedIds.has(product.id)
                        ? 'bg-accent-green text-white animate-add-success'
                        : 'bg-brand-500 text-white hover:bg-brand-600'
                    }`}
                  >
                    {addedIds.has(product.id) ? (
                      <>
                        <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                        {t('product.added_short')}
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5" strokeWidth={2} />
                        {t('common.add')}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
