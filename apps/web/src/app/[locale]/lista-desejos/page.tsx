'use client'

import { useWishlistStore } from '@/domains/wishlist'
import { useProducts } from '@/domains/product'
import { ProductGrid } from '@/components/organisms'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { track } from '@/domains/analytics'
import { useMemo } from 'react'
import { Heart } from 'lucide-react'

export default function WishlistPage() {
  const t = useTranslations()
  const wishlistItems = useWishlistStore((s) => s.items)
  const addToCart = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  // Fetch a broad pool so we can match wishlist IDs
  const { data, loading } = useProducts({ limit: 200 })

  const wishlistProducts = useMemo(() => {
    if (!data?.items || wishlistItems.length === 0) return []
    return wishlistItems
      .map((id) => data.items.find((p) => p.id === id))
      .filter(Boolean) as NonNullable<typeof data.items>[number][]
  }, [data?.items, wishlistItems])

  const handleAddToCart = (productId: string) => {
    const product = wishlistProducts.find((p) => p.id === productId)
    if (!product) return
    const defaultVariant = product.variants?.[0]
    addToCart(product, 1, undefined, defaultVariant)
    track('add_to_cart', { productId, source: 'wishlist' })
    addToast(t('toast.added_to_cart'), 'cart')
  }

  // Empty state
  if (!loading && wishlistItems.length === 0) {
    return (
      <div className="min-h-screen bg-smoke-50 mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="text-3xl font-display text-charcoal-900">
          {t('wishlist.title')}
        </h1>
        <div className="mt-16 flex flex-col items-center justify-center gap-4 text-center">
          <Heart className="w-12 h-12 text-smoke-200" />
          <p className="text-lg text-smoke-400">
            Nenhum item na sua lista de desejos
          </p>
          <Link
            href="/loja"
            className="mt-4 text-sm font-medium text-charcoal-700 hover:text-charcoal-900 transition-colors duration-300"
          >
            {t('cart.continue_shopping')} →
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50 mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-display text-charcoal-900">
        {t('wishlist.title')}
      </h1>

      <div className="mt-8">
        <ProductGrid
          products={wishlistProducts}
          columns={4}
          isLoading={loading}
          onAddToCart={handleAddToCart}
          getProductHref={(p) => `/loja/produto/${p.id}`}
        />
      </div>
    </div>
  )
}
