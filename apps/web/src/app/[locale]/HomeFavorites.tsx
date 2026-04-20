'use client'

import { useWishlistStore } from '@/domains/wishlist'
import { useProducts } from '@/domains/product'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ProductGrid } from '@/components/organisms'
import { Container, Heading } from '@/components/atoms'
import { ArrowRight } from 'lucide-react'
import { track } from '@/domains/analytics'
import { useMemo } from 'react'

// Cap how many favorites the home strip will ever render. The grid below
// wraps responsively (2 cols mobile → 4 cols desktop), so 4 = 2 rows on mobile
// and 1 row on desktop — a tight strip that always leaves room for a clear
// "Ver todos" link rather than dumping the whole wishlist on the home page.
// Beyond this cap users tap the link to reach /lista-desejos.
const HOME_FAVORITES_LIMIT = 4

export function HomeFavorites() {
  const t = useTranslations()
  const wishlistItems = useWishlistStore((s) => s.items)
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  // Fetch all products to filter by wishlist IDs
  const { data } = useProducts({ limit: 100 })
  const allProducts = useMemo(() => data?.items ?? [], [data?.items])

  const { displayedProducts, totalFavoritesInCatalog } = useMemo(() => {
    if (wishlistItems.length === 0) return { displayedProducts: [], totalFavoritesInCatalog: 0 }
    const wishlistSet = new Set(wishlistItems)
    const matched = allProducts.filter((p) => wishlistSet.has(p.id))
    return {
      displayedProducts: matched.slice(0, HOME_FAVORITES_LIMIT),
      totalFavoritesInCatalog: matched.length,
    }
  }, [wishlistItems, allProducts])

  if (displayedProducts.length === 0) return null

  const hasMore = totalFavoritesInCatalog > HOME_FAVORITES_LIMIT

  const handleAddToCart = (productId: string) => {
    const product = displayedProducts.find((p) => p.id === productId)
    if (product) {
      const defaultVariant = product.variants?.[0]
      addItem(product, 1, undefined, defaultVariant)
      track('add_to_cart', { productId, source: 'favorites_homepage' })
      addToast(t('product.added'), 'cart')
    }
  }

  return (
    <section className="bg-smoke-50 border-t border-smoke-200/30">
      <Container size="xl" className="py-16 lg:py-24">
        {/* Header — heading + count + always-visible "Ver todos" link.
            The link is shown on every breakpoint when there's more to see;
            previously it was hidden on mobile and shoved into a centered link
            below the grid, easy to miss. */}
        <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
          <Heading as="h2" className="font-display text-display-xs sm:text-display-sm font-semibold text-charcoal-900 tracking-display">
            {t('favorites.title')}
            <span className="ml-3 text-sm font-normal tracking-normal text-smoke-500 tabular-nums">
              · {totalFavoritesInCatalog}
            </span>
          </Heading>
          {hasMore && (
            <Link
              href="/lista-desejos"
              className="inline-flex items-center gap-1 text-sm font-medium text-charcoal-700 hover:text-charcoal-900 transition-colors duration-300"
            >
              Ver todos os {totalFavoritesInCatalog}
              <ArrowRight className="w-4 h-4" strokeWidth={1.75} />
            </Link>
          )}
        </div>
        <ProductGrid
          products={displayedProducts}
          columns={4}
          onAddToCart={handleAddToCart}
          getProductHref={(p) => `/loja/produto/${p.id}`}
        />
      </Container>
    </section>
  )
}
