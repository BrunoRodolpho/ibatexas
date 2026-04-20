'use client'

import { useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useProducts } from '@/domains/product'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { ProductGrid } from '@/components/organisms'
import { ProductGridSkeleton } from '@/components/molecules/ProductGridSkeleton'
import { Container, Heading, Text } from '@/components/atoms'
import { track } from '@/domains/analytics'
import { notFound } from 'next/navigation'

const validCategories = new Set(['camisetas', 'acessorios', 'kits'])

interface CategoryContentProps {
  readonly category: string
}

export default function CategoryContent({ category }: CategoryContentProps) {
  const t = useTranslations()
  const addItem = useCartStore((s) => s.addItem)
  const triggerUpsell = useUIStore((s) => s.triggerUpsell)
  const addToast = useUIStore((s) => s.addToast)

  if (!validCategories.has(category)) {
    notFound()
  }

  const { data, loading, error } = useProducts({
    limit: 20,
    productType: 'merchandise',
    categoryHandle: category,
  })

  // Memoized so the handleAddToCart useCallback dep array is stable across
  // renders that don't actually change the product list.
  const filteredProducts = useMemo(() => data?.items ?? [], [data?.items])

  // Add-to-cart from a category card now matches the /search behavior:
  // 1. add to cart, 2. toast confirmation, 3. trigger cross-sell upsell.
  // Previously this handler was missing, so cards in /loja/[category] silently
  // did nothing on click and never surfaced the upsell toast.
  const handleAddToCart = useCallback(
    (productId: string) => {
      const product = filteredProducts.find((p) => p.id === productId)
      if (!product) return
      const defaultVariant = product.variants?.[0]
      addItem(product, 1, undefined, defaultVariant)
      track('add_to_cart', { productId, source: 'category_listing' })
      addToast(t('toast.added_to_cart'), 'cart')
      if (product.categoryHandle) {
        triggerUpsell(product.categoryHandle)
      }
    },
    [filteredProducts, addItem, addToast, t, triggerUpsell],
  )

  if (error) {
    return (
      <div className="text-center py-12">
        <Text variant="body" className="text-accent-red">
          {t('common.error')}: {error.message}
        </Text>
      </div>
    )
  }

  const categoryKey = `shop.categories.${category}` as const

  // Render the page chrome (header + description) at all times so the layout
  // is stable. The grid area swaps between skeleton, real grid, and empty
  // state — only that area changes during loading.
  return (
    <Container className="py-8 lg:py-12">
      <div className="text-center mb-12">
        <Heading variant="h1" className="text-charcoal-900 mb-4">
          {t(categoryKey)}
        </Heading>
        <Text variant="body" className="text-smoke-400">
          {t(`shop.category_descriptions.${category}`)}
        </Text>
      </div>

      {(() => {
        if (loading) {
          return <ProductGridSkeleton columns={3} />
        }
        if (filteredProducts.length) {
          return (
            <ProductGrid
              products={filteredProducts}
              onAddToCart={handleAddToCart}
              getProductHref={(product) => `/loja/produto/${product.id}`}
            />
          )
        }
        return (
          <div className="text-center py-12">
            <Text variant="body" className="text-smoke-400">
              {t('shop.empty_states.no_products')}
            </Text>
          </div>
        )
      })()}
    </Container>
  )
}
