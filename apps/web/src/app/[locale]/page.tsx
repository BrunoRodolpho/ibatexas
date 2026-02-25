'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { ProductGrid } from '@/components/organisms/ProductGrid'
import { CategoryCarousel } from '@/components/molecules/CategoryCarousel'
import { useProducts, useCategories } from '@/hooks/api'
import { useUIStore } from '@/stores/useUIStore'
import { useCartStore } from '@/stores/useCartStore'
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
    { icon: '🔥', value: t('home.stats_hours_value'), label: t('home.stats_hours_label') },
    { icon: '🥩', value: t('home.stats_ingredients_value'), label: t('home.stats_ingredients_label') },
    { icon: '🚚', value: t('home.stats_deliveries_value'), label: t('home.stats_deliveries_label') },
    { icon: '⭐', value: t('home.stats_rating_value'), label: t('home.stats_rating_label') },
  ]

  return (
    <>
      {/* ═══════════════════════════════════════════════════════════════
          SECTION 1 — Hero (max 60vh, split layout)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="border-b border-slate-200">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8 lg:py-10">
          <div className="grid lg:grid-cols-2 gap-8 items-center" style={{ maxHeight: '60vh' }}>
            {/* Left — headline + CTAs */}
            <div className="flex flex-col justify-center">
              <span className="inline-block w-fit rounded-full bg-brand-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-600 mb-4">
                {t('home.badge_ai_native')}
              </span>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-900 leading-tight">
                {t('home.hero_title')}
              </h1>
              <p className="mt-3 text-[15px] text-slate-500 leading-relaxed max-w-md">
                {t('home.hero_subtitle')}
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => setChat(true)}
                  className="bg-slate-900 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-slate-800 transition-colors rounded-lg"
                >
                  {t('home.order_via_ai')}
                </button>
                <Link
                  href="/search"
                  className="border border-slate-300 px-5 py-2.5 text-[13px] font-semibold text-slate-700 hover:border-slate-400 hover:text-slate-900 transition-colors rounded-lg"
                >
                  {t('home.view_menu')}
                </Link>
              </div>
            </div>

            {/* Right — chat preview mockup */}
            <div className="hidden lg:block">
              <div className="mx-auto max-w-sm rounded-xl border border-slate-200 bg-white shadow-card overflow-hidden">
                {/* Chat header */}
                <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 bg-slate-50">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900">
                    <span className="text-[10px] font-bold text-white">IA</span>
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-slate-900">{t('home.chat_preview_assistant')}</p>
                    <p className="text-[10px] text-emerald-600 font-medium">{t('home.chat_preview_online')}</p>
                  </div>
                </div>
                {/* Chat messages */}
                <div className="px-4 py-4 space-y-3">
                  {/* Assistant greeting */}
                  <div className="flex gap-2">
                    <div className="flex-shrink-0 h-6 w-6 rounded-full bg-slate-100 flex items-center justify-center">
                      <span className="text-[8px] font-bold text-slate-500">IA</span>
                    </div>
                    <div className="rounded-lg rounded-tl-none bg-slate-100 px-3 py-2 max-w-[75%]">
                      <p className="text-[12px] text-slate-700 leading-relaxed">{t('home.chat_preview_greeting')}</p>
                    </div>
                  </div>
                  {/* User message */}
                  <div className="flex justify-end">
                    <div className="rounded-lg rounded-tr-none bg-slate-900 px-3 py-2 max-w-[75%]">
                      <p className="text-[12px] text-white leading-relaxed">{t('home.chat_preview_user')}</p>
                    </div>
                  </div>
                  {/* Assistant reply */}
                  <div className="flex gap-2">
                    <div className="flex-shrink-0 h-6 w-6 rounded-full bg-slate-100 flex items-center justify-center">
                      <span className="text-[8px] font-bold text-slate-500">IA</span>
                    </div>
                    <div className="rounded-lg rounded-tl-none bg-slate-100 px-3 py-2 max-w-[75%]">
                      <p className="text-[12px] text-slate-700 leading-relaxed">{t('home.chat_preview_reply')}</p>
                    </div>
                  </div>
                </div>
                {/* Chat input mockup */}
                <div className="border-t border-slate-100 px-4 py-3">
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="text-[12px] text-slate-400 flex-1">{t('home.chat_preview_placeholder')}</span>
                    <svg className="h-4 w-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — Sticky category nav (below header)
          ═══════════════════════════════════════════════════════════════ */}
      <nav className="sticky top-[76px] z-20 border-y border-slate-200 bg-white">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <div className="flex items-center gap-2 py-2.5 overflow-x-auto scrollbar-hide">
            <Link
              href="/search"
              className="flex-shrink-0 rounded-full border border-slate-900 bg-slate-900 px-3 py-1 text-[12px] font-semibold text-white"
            >
              {t('home.all_categories')}
            </Link>
            {!categoriesLoading && categories && (categories as any[]).length > 0 && (
              <CategoryCarousel categories={categories as any[]} />
            )}
            {categoriesLoading && (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex-shrink-0 h-7 w-20 rounded-full skeleton" />
                ))}
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — Dense product grid (4 cols desktop, 12 products)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="border-b border-slate-200">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8">
          {/* Section header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-[15px] font-semibold text-slate-900">
                {t('home.our_menu')}
              </h2>
              <span className="text-[12px] text-slate-400">
                {t('home.our_menu_subtitle')}
              </span>
            </div>
            <Link
              href="/search"
              className="text-[12px] font-medium text-slate-500 hover:text-slate-900 transition-colors"
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
          SECTION 4 — Operational highlights (stats band)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="border-y border-slate-100 bg-slate-50">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map((stat, i) => (
              <div
                key={i}
                className="flex flex-col items-center text-center bg-white border border-slate-100 rounded-lg px-4 py-5"
              >
                <span className="text-2xl mb-2">{stat.icon}</span>
                <span className="text-xl font-bold text-slate-900 tabular-nums">{stat.value}</span>
                <span className="mt-1 text-[12px] text-slate-500">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 5 — CTA band (dark, 2-column)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-slate-900">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
            {/* Left — text */}
            <div className="text-center sm:text-left">
              <h2 className="text-lg font-semibold text-white">
                {t('home.cta_title')}
              </h2>
              <p className="mt-1 text-[13px] text-slate-400">
                {t('home.cta_subtitle')}
              </p>
            </div>
            {/* Right — buttons */}
            <div className="flex items-center gap-3 flex-shrink-0">
              <button
                onClick={() => setChat(true)}
                className="bg-white px-5 py-2.5 text-[13px] font-semibold text-slate-900 hover:bg-slate-100 transition-colors rounded-lg"
              >
                {t('home.cta_button_ai')}
              </button>
              <Link
                href="/search"
                className="border border-slate-500 px-5 py-2.5 text-[13px] font-semibold text-white hover:border-white transition-colors rounded-lg"
              >
                {t('home.cta_button_menu')}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
