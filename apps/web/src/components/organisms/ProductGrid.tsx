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
    3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
  }[columns] || 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'

  if (isLoading) {
    return (
      <div className={`grid ${gridColsClass} gap-4`}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-square bg-slate-200 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  if (isEmpty || !products || products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
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
