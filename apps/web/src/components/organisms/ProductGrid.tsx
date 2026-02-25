'use client'

import { ProductCard } from '../molecules/ProductCard'
import { Text } from '../atoms'

interface Product {
  id: string
  title: string
  imageUrl?: string | null
  price: number
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
  const gridColsClass = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
  }[columns] || 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'

  if (isLoading) {
    return (
      <div className={`grid ${gridColsClass} gap-4`}>
        {Array.from({ length: columns === 5 ? 10 : 8 }).map((_, i) => (
          <div key={i} className="border border-slate-200 bg-white overflow-hidden">
            <div className="aspect-[3/2] skeleton" />
            <div className="px-2 py-1.5 space-y-1.5">
              <div className="h-3 w-3/4 rounded-sm skeleton" />
              <div className="h-3 w-1/3 rounded-sm skeleton" />
              <div className="h-6 w-full rounded-sm skeleton mt-1" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (isEmpty || !products || products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <span className="text-4xl">🔍</span>
        <Text textColor="muted">{emptyMessage || 'Nenhum produto encontrado'}</Text>
      </div>
    )
  }

  return (
    <div className={`grid ${gridColsClass} gap-4`}>
      {products.map((product) => (
        <ProductCard
          key={product.id}
          {...product}
          href={getProductHref?.(product)}
          onAddToCart={() => onAddToCart?.(product.id)}
        />
      ))}
    </div>
  )
}
