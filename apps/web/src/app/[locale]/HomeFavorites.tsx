'use client'

import { useWishlistStore } from '@/domains/wishlist'
import { useProducts } from '@/domains/product'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { useTranslations } from 'next-intl'
import { ProductGrid } from '@/components/organisms'
import { Heading } from '@/components/atoms'
import { track } from '@/domains/analytics'
import { useMemo } from 'react'
import type { ProductDTO } from '@ibatexas/types'

export function HomeFavorites() {
  const t = useTranslations()
  const wishlistItems = useWishlistStore((s) => s.items)
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  // Fetch all products to filter by wishlist IDs
  const { data } = useProducts({ limit: 100 })
  const allProducts = useMemo(() => data?.items ?? [], [data?.items])

  const favoriteProducts = useMemo(() => {
    if (wishlistItems.length === 0) return []
    const wishlistSet = new Set(wishlistItems)
    return allProducts.filter((p) => wishlistSet.has(p.id)).slice(0, 4)
  }, [wishlistItems, allProducts])

  if (favoriteProducts.length === 0) return null

  const handleAddToCart = (productId: string) => {
    const product = favoriteProducts.find((p) => p.id === productId)
    if (product) {
      const defaultVariant = product.variants?.[0]
      addItem(product as ProductDTO, 1, undefined, defaultVariant)
      track('add_to_cart', { productId, source: 'favorites_homepage' })
      addToast(t('product.added'), 'cart')
    }
  }

  return (
    <section className="bg-smoke-50">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-12 lg:py-16">
        <Heading as="h2" className="font-display text-display-sm font-semibold text-charcoal-900 tracking-display mb-8">
          {t('favorites.title')}
        </Heading>
        <ProductGrid
          products={favoriteProducts}
          columns={4}
          onAddToCart={handleAddToCart}
          getProductHref={(p) => `/loja/produto/${p.id}`}
        />
      </div>
    </section>
  )
}
