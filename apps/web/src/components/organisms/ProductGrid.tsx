'use client'

import { ProductCard } from '../molecules/ProductCard'
import { Text } from '../atoms'
import { useTranslations } from 'next-intl'

import type { ProductVariant } from '@ibatexas/types'

interface Product {
  id: string
  title: string
  imageUrl?: string | null
  images?: string[]
  price: number
  variants?: ProductVariant[]
  rating?: number
  tags?: string[]
}

interface ProductGridProps {
  products: Product[]
  columns?: number
  onAddToCart?: (productId: string) => void
  getProductHref?: (product: Product) => string
  isLoading?: boolean
  isEmpty?: boolean
  emptyMessage?: string
}

export const ProductGrid = ({
  products,
  columns = 3,
  onAddToCart,
  getProductHref,
  isLoading,
  isEmpty,
  emptyMessage,
}: ProductGridProps) => {
  const t = useTranslations()
  const gridColsClass = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
  }[columns] || 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'

  if (isLoading) {
    return (
      <div className={`grid ${gridColsClass} gap-x-3 sm:gap-x-4 lg:gap-x-5 gap-y-8 lg:gap-y-10`}>
        {Array.from({ length: columns === 5 ? 10 : 8 }).map((_, i) => (
          <div key={i} className="overflow-hidden">
            <div className="aspect-[4/5] rounded-card skeleton" />
            <div className="pt-3 space-y-2">
              <div className="h-3.5 w-3/4 rounded-sm skeleton" />
              <div className="h-3 w-1/3 rounded-sm skeleton" />
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

  return (
    <div className={`grid ${gridColsClass} gap-x-3 sm:gap-x-4 lg:gap-x-5 gap-y-8 lg:gap-y-10`}>
      {products.map((product, index) => (
        <div
          key={product.id}
          className="opacity-0 animate-reveal"
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <ProductCard
            {...product}
            variantCount={product.variants?.length}
            href={getProductHref?.(product)}
            onAddToCart={() => onAddToCart?.(product.id)}
            priority={index < 4}
          />
        </div>
      ))}
    </div>
  )
}
