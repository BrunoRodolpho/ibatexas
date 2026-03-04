'use client'

import { useTranslations } from 'next-intl'
import { useProducts } from '@/hooks/api'
import { ProductGrid } from '@/components/organisms'
import { Text } from '@/components/atoms'
import { Link } from '@/i18n/navigation'

export default function ShopPage() {
  const t = useTranslations()
  const { data, loading, error } = useProducts({ limit: 12, productType: 'merchandise' })

  if (error) {
    return (
      <div className="text-center py-20">
        <Text variant="body" className="text-red-600">
          {t('common.error')}: {error.message}
        </Text>
      </div>
    )
  }

  return (
    <div>
      {/* ── Featured section: editorial grid ───────────────────── */}
      <section className="bg-smoke-50">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-20 lg:py-24">
          <div className="flex items-end justify-between mb-12">
            <h2 className="font-display text-display-sm font-semibold text-charcoal-900 tracking-display">
              {t('shop.featured')}
            </h2>
            <Link
              href="/loja/camisetas"
              className="text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
            >
              {t('shop.view_all')} →
            </Link>
          </div>

          {loading ? (
            <div className="text-center py-16">
              <Text className="text-smoke-400">{t('common.loading')}</Text>
            </div>
          ) : data?.items?.length ? (
            <ProductGrid
              products={data.items}
              columns={4}
              getProductHref={(product) => `/loja/produto/${product.id}`}
            />
          ) : (
            <div className="py-20 text-center">
              <p className="font-display text-2xl text-smoke-300 tracking-display">
                Em breve
              </p>
              <p className="mt-3 text-sm text-smoke-400">
                {t('shop.empty_states.no_featured')}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ── Categories: minimal stacked layout ─────────────────── */}
      <section className="bg-smoke-100">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-20 lg:py-24">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-smoke-200">
            <Link href="/loja/camisetas" className="group bg-smoke-100 p-8 lg:p-12 transition-colors duration-500 ease-luxury hover:bg-smoke-50">
              <div className="flex items-center gap-4 mb-4">
                <svg className="w-5 h-5 text-smoke-400 group-hover:text-brand-600 transition-colors duration-500 ease-luxury" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <div className="h-px flex-1 bg-smoke-200 group-hover:bg-smoke-300 transition-colors duration-500" />
              </div>
              <h3 className="font-display text-xl font-semibold text-charcoal-900 mb-2 group-hover:text-brand-700 transition-colors duration-500 ease-luxury">
                {t('shop.categories.camisetas')}
              </h3>
              <p className="text-sm text-smoke-400 leading-relaxed">
                {t('shop.category_descriptions.camisetas')}
              </p>
            </Link>

            <Link href="/loja/acessorios" className="group bg-smoke-100 p-8 lg:p-12 transition-colors duration-500 ease-luxury hover:bg-smoke-50">
              <div className="flex items-center gap-4 mb-4">
                <svg className="w-5 h-5 text-smoke-400 group-hover:text-brand-600 transition-colors duration-500 ease-luxury" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 3l-6 6m0 0V4m0 5h5M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                </svg>
                <div className="h-px flex-1 bg-smoke-200 group-hover:bg-smoke-300 transition-colors duration-500" />
              </div>
              <h3 className="font-display text-xl font-semibold text-charcoal-900 mb-2 group-hover:text-brand-700 transition-colors duration-500 ease-luxury">
                {t('shop.categories.acessorios')}
              </h3>
              <p className="text-sm text-smoke-400 leading-relaxed">
                {t('shop.category_descriptions.acessorios')}
              </p>
            </Link>

            <Link href="/loja/kits" className="group bg-smoke-100 p-8 lg:p-12 transition-colors duration-500 ease-luxury hover:bg-smoke-50">
              <div className="flex items-center gap-4 mb-4">
                <svg className="w-5 h-5 text-smoke-400 group-hover:text-brand-600 transition-colors duration-500 ease-luxury" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
                </svg>
                <div className="h-px flex-1 bg-smoke-200 group-hover:bg-smoke-300 transition-colors duration-500" />
              </div>
              <h3 className="font-display text-xl font-semibold text-charcoal-900 mb-2 group-hover:text-brand-700 transition-colors duration-500 ease-luxury">
                {t('shop.categories.kits')}
              </h3>
              <p className="text-sm text-smoke-400 leading-relaxed">
                {t('shop.category_descriptions.kits')}
              </p>
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}