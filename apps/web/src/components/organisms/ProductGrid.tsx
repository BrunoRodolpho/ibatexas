'use client'

import { useCallback } from 'react'
import { ProductCard } from '../molecules/ProductCard'
import { ProductCardFeatured } from '../molecules/ProductCardFeatured'
import { Text } from '../atoms'
import { useTranslations } from 'next-intl'
import { useCartStore } from '@/domains/cart'

import type { ProductVariant } from '@ibatexas/types'

interface Product {
  id: string
  title: string
  subtitle?: string
  description?: string | null
  imageUrl?: string | null
  images?: string[]
  price: number
  variants?: ProductVariant[]
  rating?: number
  reviewCount?: number
  tags?: string[]
  weight?: string
  servings?: number
  stockCount?: number
  availabilityWindow?: string
  ordersToday?: number
}

interface ProductGridProps {
  products: Product[]
  columns?: number
  featured?: boolean
  onAddToCart?: (productId: string) => void
  getProductHref?: (product: Product) => string
  isLoading?: boolean
  isEmpty?: boolean
  emptyMessage?: string
}

export const ProductGrid = ({
  products,
  columns = 3,
  featured = false,
  onAddToCart,
  getProductHref,
  isLoading,
  isEmpty,
  emptyMessage,
}: ProductGridProps) => {
  const t = useTranslations()
  const cartItems = useCartStore((s) => s.items)
  const updateItem = useCartStore((s) => s.updateItem)
  const removeItem = useCartStore((s) => s.removeItem)

  /** Get cart quantity for a product (sums across all variants) */
  const getCartQuantity = useCallback(
    (productId: string) =>
      cartItems
        .filter((item) => item.productId === productId)
        .reduce((sum, item) => sum + item.quantity, 0),
    [cartItems],
  )

  /** Find the first matching cart item ID for a product */
  const getCartItemId = useCallback(
    (productId: string) => cartItems.find((item) => item.productId === productId)?.id,
    [cartItems],
  )

  const gridColsClass = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
  }[columns] || 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'

  // Full skeleton — only on initial load when no stale data exists
  if (isLoading && (!products || products.length === 0)) {
    return (
      <div className={`grid ${gridColsClass} gap-x-3 sm:gap-x-4 lg:gap-x-5 gap-y-8 lg:gap-y-10`}>
        {Array.from({ length: columns === 5 ? 10 : 8 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-card animate-pulse">
            <div className="aspect-[4/3] rounded-card bg-smoke-200" />
            <div className="pt-3 space-y-2.5">
              <div className="h-4 w-3/4 rounded bg-smoke-200" />
              <div className="h-3 w-1/3 rounded bg-smoke-200" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (isEmpty || !products || products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <div className="w-16 h-px bg-smoke-200" />
        <p className="font-display text-xl text-smoke-300 tracking-display">
          {emptyMessage || t('shop.no_products')}
        </p>
        <div className="w-16 h-px bg-smoke-200" />
      </div>
    )
  }

  // Featured mode: hero card for first item, standard grid for the rest
  const showFeatured = featured && products.length >= 3
  const heroProduct = showFeatured ? products[0] : null
  const gridProducts = showFeatured ? products.slice(1) : products

  return (
    <div className="relative">
      {/* Refresh shimmer bar — visible when reloading with stale data */}
      {isLoading && products.length > 0 && (
        <div className="absolute top-0 left-0 right-0 h-0.5 skeleton rounded-full z-10" />
      )}
      <div
        className={`space-y-10 lg:space-y-14 transition-opacity duration-300 ease-luxury ${
          isLoading ? 'opacity-40 pointer-events-none' : 'opacity-100'
        }`}
      >
      {/* Hero card — full-width horizontal layout */}
      {heroProduct && (
        <div className="opacity-0 animate-reveal">
          <ProductCardFeatured
            id={heroProduct.id}
            title={heroProduct.title}
            subtitle={heroProduct.subtitle}
            imageUrl={heroProduct.imageUrl}
            images={heroProduct.images}
            price={heroProduct.price}
            variantCount={heroProduct.variants?.length}
            tags={heroProduct.tags}
            href={getProductHref?.(heroProduct)}
            onAddToCart={onAddToCart ? () => onAddToCart(heroProduct.id) : undefined}
            cartQuantity={getCartQuantity(heroProduct.id)}
            onUpdateQuantity={(qty) => {
              const itemId = getCartItemId(heroProduct.id)
              if (itemId) updateItem(itemId, { quantity: qty })
            }}
            onRemoveFromCart={() => {
              const itemId = getCartItemId(heroProduct.id)
              if (itemId) removeItem(itemId)
            }}
          />
        </div>
      )}

      {/* Standard grid */}
      {gridProducts.length > 0 && (
        <div className={`grid ${gridColsClass} gap-x-5 sm:gap-x-6 md:gap-x-5 lg:gap-x-8 gap-y-6 lg:gap-y-8`}>
          {gridProducts.map((product, index) => {
            // Only stagger first 8 cards; subsequent cards (infinite scroll) appear instantly
            const baseIndex = showFeatured ? index + 1 : index
            const delay = baseIndex < 8 ? baseIndex * 60 : 0
            return (
            <div
              key={product.id}
              className={`h-full ${delay > 0 ? 'opacity-0 animate-reveal' : ''}`}
              style={delay > 0 ? { animationDelay: `${delay}ms` } : undefined}
            >
              <ProductCard
                {...product}
                variantCount={product.variants?.length}
                href={getProductHref?.(product)}
                onAddToCart={onAddToCart ? () => onAddToCart(product.id) : undefined}
                priority={index < 4}
                cartQuantity={getCartQuantity(product.id)}
                onUpdateQuantity={(qty) => {
                  const itemId = getCartItemId(product.id)
                  if (itemId) updateItem(itemId, { quantity: qty })
                }}
                onRemoveFromCart={() => {
                  const itemId = getCartItemId(product.id)
                  if (itemId) removeItem(itemId)
                }}
              />
            </div>
            )
          })}
        </div>
      )}
      </div>
    </div>
  )
}
