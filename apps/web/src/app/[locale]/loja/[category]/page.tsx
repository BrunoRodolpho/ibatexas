'use client'

import { useTranslations } from 'next-intl'
import { useProducts } from '@/hooks/api'
import { ProductGrid } from '@/components/organisms'
import { Heading, Text } from '@/components/atoms'
import { notFound } from 'next/navigation'

interface CategoryPageProps {
  params: {
    category: string
  }
}

const validCategories = ['camisetas', 'acessorios', 'kits']

export default function CategoryPage({ params }: CategoryPageProps) {
  const t = useTranslations()

  if (!validCategories.includes(params.category)) {
    notFound()
  }

  const { data, loading, error } = useProducts(undefined, undefined, 20, 'merchandise')

  // Filter products by category handle if we had category data
  // For now, show all merchandise since we don't have category filtering in API
  const filteredProducts = data?.products || []

  if (error) {
    return (
      <div className="text-center py-12">
        <Text variant="body" className="text-red-600">
          {t('common.error')}: {error.message}
        </Text>
      </div>
    )
  }

  const categoryKey = `shop.categories.${params.category}` as const

  return (
    <div className="space-y-6">
      {/* Category Header */}
      <div className="text-center py-8">
        <Heading variant="h1" className="text-slate-900 mb-4">
          {t(categoryKey)}
        </Heading>
        <Text variant="body" className="text-slate-600">
          {t(`shop.category_descriptions.${params.category}`)}
        </Text>
      </div>

      {/* Products */}
      {loading ? (
        <div className="text-center py-12">
          <Text>{t('common.loading')}</Text>
        </div>
      ) : filteredProducts.length ? (
        <ProductGrid 
          products={filteredProducts} 
          getProductHref={(product) => `/loja/produto/${product.id}`}
        />
      ) : (
        <div className="text-center py-12">
          <Text variant="body" className="text-slate-500">
            {t('shop.empty_states.no_products')}
          </Text>
        </div>
      )}
    </div>
  )
}