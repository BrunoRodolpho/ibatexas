'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { ProductGrid } from '@/components/organisms/ProductGrid'
import { CategoryCarousel } from '@/components/molecules/CategoryCarousel'
import { useProducts, useCategories } from '@/hooks/api'
import { useUIStore } from '@/stores/useUIStore'
import { useCartStore } from '@/stores/useCartStore'
import { Button } from '@/components/atoms'
import type { ProductDTO } from '@ibatexas/types'

export default function Home() {
  const t = useTranslations()
  const setChat = useUIStore((s) => s.setChat)
  const addToast = useUIStore((s) => s.addToast)
  const addItem = useCartStore((s) => s.addItem)

  const { data: productsData, loading: productsLoading } = useProducts(undefined, ['popular'], 12)
  const { data: categories, loading: categoriesLoading } = useCategories()

  const topProducts = productsData?.products ?? []

  const handleAddToCart = (productId: string) => {
    const product = topProducts.find((p) => p.id === productId)
    if (product) {
      addItem(product as ProductDTO, 1)
      addToast(t('product.added'), 'success')
    }
  }

  const stats = [
    { value: t('home.stats_hours_value'), label: t('home.stats_hours_label') },
    { value: t('home.stats_ingredients_value'), label: t('home.stats_ingredients_label') },
    { value: t('home.stats_deliveries_value'), label: t('home.stats_deliveries_label') },
    { value: t('home.stats_rating_value'), label: t('home.stats_rating_label') },
  ]

  return (
    <>
      {/* ═══════════════════════════════════════════════════════════════
          SECTION 1 — Hero (cinematic, textured, editorial)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="relative bg-charcoal-900 overflow-hidden grain-overlay" data-hero>
        {/* Layered atmosphere: warm fire + smoke gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-charcoal-800/60 via-charcoal-900/50 to-charcoal-900/70 pointer-events-none" />
        <div className="absolute inset-0 warm-glow pointer-events-none" />
        {/* Faint cinematic fire/smoke image at very low opacity */}
        <div className="absolute inset-0 opacity-[0.04] bg-[url('data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%20800%20600%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cfilter%20id%3D%22smoke%22%3E%3CfeTurbulence%20baseFrequency%3D%220.01%22%20numOctaves%3D%225%22%20seed%3D%222%22%2F%3E%3CfeDisplacementMap%20in%3D%22SourceGraphic%22%20scale%3D%2250%22%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url(%23smoke)%22%20fill%3D%22%23E85D04%22%20opacity%3D%220.3%22%2F%3E%3C%2Fsvg%3E')] bg-cover pointer-events-none" />

        <div className="relative mx-auto max-w-[1200px] px-4 sm:px-6 py-20 lg:py-28">
          <div className="max-w-2xl">
            <h1 className="font-display text-display-sm sm:text-display-md lg:text-display-lg font-bold text-white leading-[1.05] tracking-display">
              {t('home.hero_title')}
            </h1>
            <p className="mt-8 text-base sm:text-lg text-smoke-300 leading-relaxed measure-narrow">
              {t('home.hero_subtitle')}
            </p>
            <div className="mt-12 flex items-center gap-6">
              <Button variant="brand" size="lg" onClick={() => setChat(true)}>
                {t('home.order_via_ai')}
              </Button>
              <Link
                href="/search"
                className="text-sm font-medium text-smoke-300 hover:text-white transition-colors duration-500 ease-luxury"
              >
                {t('home.view_menu')} →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — Typographic category nav (no pills)
          ═══════════════════════════════════════════════════════════════ */}
      <nav className="sticky top-[56px] z-20 border-b border-smoke-200 bg-smoke-50/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <div className="flex items-center gap-6 py-3 overflow-x-auto scrollbar-hide">
            {!categoriesLoading && categories && (categories as any[]).length > 0 && (
              <CategoryCarousel categories={categories as any[]} />
            )}
            {categoriesLoading && (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex-shrink-0 h-4 w-16 rounded-sm skeleton" />
                ))}
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — Curated product grid (editorial spacing)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-smoke-50">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-20 lg:py-24">
          {/* Section header */}
          <div className="flex items-end justify-between mb-12">
            <div>
              <h2 className="font-display text-display-sm font-semibold text-charcoal-900 tracking-display">
                {t('home.our_menu')}
              </h2>
              <p className="mt-2 text-sm text-smoke-400 tracking-wide">
                {t('home.our_menu_subtitle')}
              </p>
            </div>
            <Link
              href="/search"
              className="text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
            >
              {t('common.view_all')} →
            </Link>
          </div>

          {/* Grid */}
          <ProductGrid
            products={topProducts}
            columns={4}
            isLoading={productsLoading}
            onAddToCart={handleAddToCart}
          />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 4 — Stats band (textured dark, editorial numbers)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-charcoal-900 grain-overlay">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-16 lg:py-22">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 sm:gap-4">
            {stats.map((stat, i) => (
              <div
                key={i}
                className="flex flex-col items-center text-center"
              >
                <span className="font-display text-display-sm sm:text-display-md font-bold text-white tabular-nums">{stat.value}</span>
                <span className="mt-3 text-[10px] font-medium uppercase tracking-editorial text-smoke-300/60">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 5 — Closing CTA (quiet authority)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-smoke-100">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-20 lg:py-30">
          <div className="max-w-xl mx-auto text-center">
            <h2 className="font-display text-display-sm sm:text-display-md font-semibold text-charcoal-900 leading-tight tracking-display">
              {t('home.cta_title')}
            </h2>
            <p className="mt-4 text-sm text-smoke-400 leading-relaxed measure-reading mx-auto">
              {t('home.cta_subtitle')}
            </p>
            <div className="mt-10">
              <Button variant="brand" size="lg" onClick={() => setChat(true)}>
                {t('home.cta_button_ai')}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
