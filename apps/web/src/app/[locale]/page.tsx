'use client'

import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import { Heading, Text, Button } from '@/components/atoms'
import { ProductGrid } from '@/components/organisms/ProductGrid'
import { CategoryCarousel } from '@/components/molecules/CategoryCarousel'
import { useProducts, useCategories } from '@/hooks/api'

export default function Home() {
  const t = useTranslations()
  const locale = useLocale()

  const { data: productsData, loading: productsLoading } = useProducts(undefined, ['popular'], 6)
  const { data: categories, loading: categoriesLoading } = useCategories()

  const topProducts = productsData?.products ?? []

  const handleAddToCart = (productId: string) => {
    // TODO: navigate to product detail for proper add-to-cart with quantity
    console.log('Add to cart:', productId)
  }

  return (
    <>
      {/* Hero Section */}
      <section className="border-b bg-gradient-to-r from-amber-50 to-yellow-50 py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <Heading as="h1" variant="h1" className="text-amber-900">
            {t('home.hero_title')}
          </Heading>
          <Text variant="body" textColor="secondary" className="mx-auto mt-6 max-w-2xl text-lg">
            {t('home.hero_subtitle')}
          </Text>
          <div className="mt-10 flex gap-4 justify-center flex-wrap">
            <Link href={`/${locale}/search`}>
              <Button variant="primary" size="lg">
                {t('home.browse_menu')}
              </Button>
            </Link>
            <Link href={`/${locale}/account/reservations`}>
              <Button variant="secondary" size="lg">
                {t('home.make_reservation')}
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Featured Products */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-12 flex items-center justify-between">
            <div>
              <Heading as="h2" variant="h2">
                {t('home.featured_products')}
              </Heading>
              <Text textColor="muted" className="mt-2">
                {t('home.featured_subtitle')}
              </Text>
            </div>
            <Link href={`/${locale}/search?tags=popular`} className="text-amber-700 font-medium hover:text-amber-800">
              {t('common.view_all')} →
            </Link>
          </div>

          <ProductGrid
            products={topProducts}
            columns={3}
            isLoading={productsLoading}
            onAddToCart={handleAddToCart}
          />
        </div>
      </section>

      {/* Categories */}
      <section className="border-t bg-slate-50 py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Heading as="h2" variant="h2" className="mb-12">
            {t('home.categories')}
          </Heading>

          {categoriesLoading ? (
            <div className="flex gap-4 overflow-x-auto pb-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex-shrink-0 w-40 h-24 bg-slate-200 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : categories && (categories as any[]).length > 0 ? (
            <CategoryCarousel categories={categories as any[]} />
          ) : (
            <Text textColor="muted">{t('home.no_categories')}</Text>
          )}
        </div>
      </section>

      {/* Call to Action */}
      <section className="bg-amber-700 py-16 text-center text-white">
        <Heading as="h2" variant="h2" className="text-white">
          {t('home.delivery_cta_title')}
        </Heading>
        <Text textColor="secondary" className="mt-4 text-amber-100">
          {t('home.delivery_cta_subtitle')}
        </Text>
        <Link href={`/${locale}/search`}>
          <Button variant="primary" size="lg" className="mt-8 bg-white text-amber-700 hover:bg-slate-50">
            {t('home.order_now')}
          </Button>
        </Link>
      </section>
    </>
  )
}
