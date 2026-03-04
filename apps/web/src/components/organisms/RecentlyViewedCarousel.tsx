'use client'

import { useTranslations } from 'next-intl'
import { useRecentlyViewed } from '@/hooks/useRecentlyViewed'
import { useProducts } from '@/hooks/api'
import { ProductCard } from '../molecules/ProductCard'
import { Heading } from '../atoms'
import { useCartStore, useUIStore } from '@/stores'
import { track } from '@/lib/analytics'
import type { ProductDTO } from '@ibatexas/types'

interface RecentlyViewedCarouselProps {
  /** Product ID to exclude (e.g., the current PDP product) */
  excludeId?: string
}

/**
 * Horizontal carousel showing last 10 viewed products.
 * Rendered on home and search pages.
 */
export function RecentlyViewedCarousel({ excludeId }: RecentlyViewedCarouselProps) {
  const t = useTranslations()
  const { getIds } = useRecentlyViewed()
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  const recentIds = getIds(excludeId)

  // Don't render unless we have at least 2 recently viewed products
  if (recentIds.length < 2) return null

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
      <div className="mb-6">
        <div className="h-px w-12 bg-brand-500 mb-4" />
        <Heading as="h2" variant="h3" className="text-charcoal-900">
          {t('recently_viewed.title')}
        </Heading>
      </div>

      <div className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 -mx-4 px-4 snap-x snap-mandatory">
        {recentIds.slice(0, 8).map((id) => (
          <div key={id} className="flex-shrink-0 w-[160px] sm:w-[200px] snap-start">
            <RecentlyViewedCard productId={id} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Minimal card that fetches a single product by ID */
function RecentlyViewedCard({ productId }: { productId: string }) {
  const { data: productsData } = useProducts({ query: productId, limit: 1 })
  const product = productsData?.items?.[0]

  if (!product) {
    return (
      <div className="aspect-[4/5] rounded-card skeleton" />
    )
  }

  return (
    <ProductCard
      id={product.id}
      title={product.title}
      imageUrl={product.imageUrl}
      images={product.images}
      price={product.price}
      tags={product.tags}
      href={`/loja/produto/${product.id}`}
    />
  )
}
