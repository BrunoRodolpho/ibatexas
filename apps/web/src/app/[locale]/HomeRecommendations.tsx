'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRecommendations } from '@/domains/recommendations'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { track, trackOnceVisible } from '@/domains/analytics'
import { Heading, Container } from '@/components/atoms'
import NextImage from 'next/image'
import { Link } from '@/i18n/navigation'
import { Plus, Sparkles } from 'lucide-react'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { formatBRL } from '@/lib/format'
import type { RecommendedProduct } from '@/domains/recommendations'
import { AvailabilityWindow, ProductType } from '@ibatexas/types'
import type { ProductDTO } from '@ibatexas/types'

/**
 * "Recomendado para Você" — personalized recommendations on the homepage.
 * Gated behind `recommendation_engine` feature flag.
 * Returns null when flag is off or no recommendations available.
 */
export function HomeRecommendations() {
  const t = useTranslations()
  const { data: recommendations, loading } = useRecommendations(6)
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()
  const sectionRef = useRef<HTMLElement>(null)

  // Fire impression event once when the section first enters the viewport.
  // Without this the `homepage_recs_clicked` CTR has no denominator.
  useEffect(() => {
    if (!sectionRef.current || loading || recommendations.length === 0) return
    return trackOnceVisible(sectionRef.current, 'homepage_recs_viewed', {
      count: recommendations.length,
      productIds: recommendations.map((r) => r.id),
    })
  }, [loading, recommendations])

  if (loading || recommendations.length === 0) return null

  const handleQuickAdd = (product: RecommendedProduct) => {
    const minimalProduct: ProductDTO = {
      id: product.id,
      title: product.title,
      price: product.price,
      imageUrl: product.imageUrl ?? null,
      description: null,
      images: product.imageUrl ? [product.imageUrl] : [],
      tags: [],
      availabilityWindow: AvailabilityWindow.SEMPRE,
      allergens: [],
      variants: [],
      productType: ProductType.FOOD,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    addItem(minimalProduct, 1)
    track('homepage_recs_clicked', { productId: product.id })
    addToast(t('product.added'), 'cart')
  }

  return (
    <section ref={sectionRef} className="bg-smoke-50 border-t border-smoke-200/30">
      <Container size="xl" className="py-16 lg:py-24">
        {/* Section header */}
        <div className="flex items-center gap-2 mb-8">
          <Sparkles className="w-5 h-5 text-brand-500" strokeWidth={2} />
          <Heading as="h2" className="font-display text-display-xs font-semibold text-charcoal-900 tracking-display">
            {t('recommendations.title')}
          </Heading>
        </div>

        {/* Horizontal scrollable cards */}
        <div className="flex gap-3 overflow-x-auto scrollbar-hide snap-x snap-mandatory pb-2 -mx-4 px-4">
          {recommendations.map((product) => {
            const priceFormatted = formatBRL(product.price)

            return (
              <div key={product.id} className="flex-shrink-0 snap-start w-[172px] sm:w-[192px] group">
                <div className="surface-card rounded-card overflow-hidden transition-all duration-500 ease-luxury group-hover:shadow-md group-hover:-translate-y-0.5">
                  {/* Image */}
                  <div className="relative aspect-square overflow-hidden bg-smoke-100">
                    {product.imageUrl ? (
                      <>
                        <NextImage
                          src={product.imageUrl}
                          alt={product.title}
                          fill
                          sizes="180px"
                          placeholder="blur"
                          blurDataURL={BLUR_PLACEHOLDER}
                          className="object-cover contrast-[1.08] group-hover:scale-[1.05] transition-transform duration-800 ease-luxury"
                        />
                        <div className="absolute inset-0 bg-brand-50/5 mix-blend-multiply pointer-events-none" />
                      </>
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-br from-smoke-100 to-smoke-200 grain-overlay flex items-center justify-center">
                        <span className="font-display text-xs tracking-[0.2em] text-smoke-300/30 uppercase">IbateXas</span>
                      </div>
                    )}

                    {/* Quick add */}
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        handleQuickAdd(product)
                      }}
                      className="absolute bottom-1.5 right-1.5 z-10 bg-charcoal-900 text-smoke-50 h-8 w-8 rounded-full shadow-md flex items-center justify-center opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-all duration-500 ease-luxury hover:bg-charcoal-700 active:scale-90"
                      aria-label={`${t('product.add_to_cart')} - ${product.title}`}
                    >
                      <Plus className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                  </div>

                  {/* Details */}
                  <div className="p-3">
                    <h3 className="font-display text-sm font-medium text-charcoal-900 leading-snug truncate">
                      <Link href={`/loja/produto/${product.id}`} className="after:absolute after:inset-0 after:content-['']">
                        {product.title}
                      </Link>
                    </h3>
                    {product.reason && (
                      <p className="text-[10px] text-smoke-400 mt-1 truncate">{product.reason}</p>
                    )}
                    <p className="mt-1.5 text-sm font-semibold tabular-nums text-charcoal-900">
                      {priceFormatted}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Container>
    </section>
  )
}
