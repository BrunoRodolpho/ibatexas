'use client'

import { useTranslations } from 'next-intl'
import { useProducts } from '@/domains/product'
import { ProductGrid } from '@/components/organisms'
import { Heading, Text } from '@/components/atoms'
import { notFound } from 'next/navigation'

const validCategories = new Set(['camisetas', 'acessorios', 'kits'])

interface CategoryContentProps {
  readonly category: string
}

export default function CategoryContent({ category }: CategoryContentProps) {
  const t = useTranslations()

  if (!validCategories.has(category)) {
    notFound()
  }

  const { data, loading, error } = useProducts({
    limit: 20,
    productType: 'merchandise',
    categoryHandle: category,
  })

  const filteredProducts = data?.items ?? []

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

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 lg:py-20">
      {/* Category Header */}
      <div className="text-center mb-12">
        <Heading variant="h1" className="text-charcoal-900 mb-4">
          {t(categoryKey)}
        </Heading>
        <Text variant="body" className="text-smoke-400">
          {t(`shop.category_descriptions.${category}`)}
        </Text>
      </div>

      {/* Products */}
      {(() => {
        if (loading) {
          return (
            <div className="text-center py-12">
              <Text>{t('common.loading')}</Text>
            </div>
          )
        }
        if (filteredProducts.length) {
          return (
            <ProductGrid
              products={filteredProducts}
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
    </div>
  )
}
