'use client'

import { useTranslations } from 'next-intl'
import { useProducts } from '@/hooks/api'
import { ProductGrid } from '@/components/organisms'
import { Heading, Text, Button } from '@/components/atoms'
import { Link } from '@/i18n/navigation'

export default function ShopPage() {
  const t = useTranslations()
  const { data, loading, error } = useProducts(undefined, undefined, 12, 'merchandise')

  if (error) {
    return (
      <div className="text-center py-12">
        <Text variant="body" className="text-red-600">
          {t('common.error')}: {error.message}
        </Text>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center py-12 bg-gradient-to-r from-brand-50 to-brand-100 rounded-2xl px-6">
        <Heading variant="h1" className="text-slate-900 mb-4">
          {t('shop.hero_title')}
        </Heading>
        <Text variant="body" className="text-slate-600 max-w-2xl mx-auto">
          {t('shop.hero_subtitle')}
        </Text>
      </div>

      {/* Featured Products */}
      <section>
        <div className="flex items-center justify-between mb-6">
          <Heading variant="h2" className="text-slate-900">
            {t('shop.featured')}
          </Heading>
          <Button variant="tertiary" asChild>
            <Link href={"/loja/camisetas"}>
              {t('shop.view_all')}
            </Link>
          </Button>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <Text>{t('common.loading')}</Text>
          </div>
        ) : data?.products.length ? (
          <ProductGrid 
            products={data.products} 
            getProductHref={(product) => `/loja/produto/${product.id}`}
          />
        ) : (
          <div className="text-center py-12">
            <Text variant="body" className="text-slate-500">
              {t('shop.empty_states.no_featured')}
            </Text>
          </div>
        )}
      </section>

      {/* Browse by Category */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Link href={"/loja/camisetas"} className="group">
          <div className="rounded-lg border border-slate-200 p-5 hover:shadow-md transition-shadow">
            <div className="w-10 h-10 bg-slate-100 rounded-md flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <Heading variant="h3" className="text-slate-900 mb-1 group-hover:text-slate-600">
              {t('shop.categories.camisetas')}
            </Heading>
            <Text className="text-slate-600">
              {t('shop.category_descriptions.camisetas')}
            </Text>
          </div>
        </Link>

        <Link href={"/loja/acessorios"} className="group">
          <div className="rounded-lg border border-slate-200 p-5 hover:shadow-md transition-shadow">
            <div className="w-10 h-10 bg-slate-100 rounded-md flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 3l-6 6m0 0V4m0 5h5M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
              </svg>
            </div>
            <Heading variant="h3" className="text-slate-900 mb-1 group-hover:text-slate-600">
              {t('shop.categories.acessorios')}
            </Heading>
            <Text className="text-slate-600">
              {t('shop.category_descriptions.acessorios')}
            </Text>
          </div>
        </Link>

        <Link href={"/loja/kits"} className="group">
          <div className="rounded-lg border border-slate-200 p-5 hover:shadow-md transition-shadow">
            <div className="w-10 h-10 bg-slate-100 rounded-md flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
              </svg>
            </div>
            <Heading variant="h3" className="text-slate-900 mb-1 group-hover:text-slate-600">
              {t('shop.categories.kits')}
            </Heading>
            <Text className="text-slate-600">
              {t('shop.category_descriptions.kits')}
            </Text>
          </div>
        </Link>
      </section>
    </div>
  )
}