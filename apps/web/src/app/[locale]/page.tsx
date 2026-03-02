'use client'

import { useState, useEffect } from 'react'
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

  const { data: productsData, loading: productsLoading } = useProducts(undefined, undefined, 12)
  const { data: apiCategories, loading: categoriesLoading } = useCategories()

  // Fallback categories matching seed data — shown when API is unavailable
  const FALLBACK_CATEGORIES = [
    { id: 'carnes-defumadas', name: 'Carnes Defumadas', handle: 'carnes-defumadas' },
    { id: 'acompanhamentos', name: 'Acompanhamentos', handle: 'acompanhamentos' },
    { id: 'sanduiches', name: 'Sanduíches & Combos', handle: 'sanduiches' },
    { id: 'sobremesas', name: 'Sobremesas', handle: 'sobremesas' },
    { id: 'bebidas', name: 'Bebidas', handle: 'bebidas' },
    { id: 'congelados', name: 'Congelados', handle: 'congelados' },
  ]

  const categories = (apiCategories as any[])?.length ? apiCategories as any[] : FALLBACK_CATEGORIES

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

  // Show category nav only after scrolling past the hero
  const [pastHero, setPastHero] = useState(false)
  useEffect(() => {
    const hero = document.querySelector('[data-hero]')
    if (!hero) return
    const obs = new IntersectionObserver(
      ([entry]) => setPastHero(!entry.isIntersecting),
      { threshold: 0 }
    )
    obs.observe(hero)
    return () => obs.disconnect()
  }, [])

  return (
    <>
      {/* ═══════════════════════════════════════════════════════════════
          SECTION 1 — Hero (layered composition, not grid)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="relative bg-smoke-50 overflow-hidden" data-hero>

        {/* Video — positioned as backdrop on the left (desktop only) */}
        <div className="hidden lg:block absolute top-4 bottom-0 left-[2%] w-[52%] pointer-events-none">
          <video
            autoPlay
            muted
            loop
            playsInline
            preload="none"
            className="h-full w-full object-contain object-left brightness-[0.98] sepia-[0.03]"
            aria-hidden="true"
          >
            <source src="/videos/pitmaster-hero.mp4" type="video/mp4" />
          </video>
        </div>

        {/* White gradient — fades video into white on the right */}
        <div className="hidden lg:block absolute inset-y-0 left-[34%] w-[28%] bg-gradient-to-r from-transparent to-smoke-50 pointer-events-none" />

        {/* Content layer */}
        <div className="relative mx-auto max-w-[1400px] px-6 sm:px-8 py-4 lg:pt-14 lg:pb-20 lg:min-h-[460px] lg:flex lg:items-start">

          {/* Mobile — video above text */}
          <div className="lg:hidden flex justify-center mb-2">
            <div className="w-[100%] sm:w-[85%]">
              <video
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                className="w-full h-auto brightness-[0.98] sepia-[0.03]"
                aria-hidden="true"
              >
                <source src="/videos/pitmaster-hero.mp4" type="video/mp4" />
              </video>
            </div>
          </div>

          {/* Text — centered on desktop, overlaps video edge */}
          <div className="text-center lg:text-left lg:ml-[46%] lg:max-w-[600px] animate-reveal">
            <h1 className="font-display text-display-md sm:text-display-lg lg:text-display-xl font-bold text-brand-500 leading-[1.02] tracking-display">
              {t('home.hero_title')}
            </h1>
            <p className="mt-4 lg:mt-6 font-display italic text-xl sm:text-2xl text-smoke-400 leading-relaxed mx-auto lg:mx-0">
              {t('home.hero_subtitle')}
            </p>
          </div>

        </div>

        {/* Bottom accent */}
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-smoke-200 to-transparent" />
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — Typographic category nav (no pills)
          ═══════════════════════════════════════════════════════════════ */}
      <nav className={`sticky top-[56px] z-20 border-b border-smoke-200 bg-smoke-50/95 backdrop-blur-sm transition-all duration-500 ease-luxury ${pastHero ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'}`}>
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <div className="flex items-center gap-6 py-3 overflow-x-auto scrollbar-hide">
            {categoriesLoading ? (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex-shrink-0 h-4 w-16 rounded-sm skeleton" />
                ))}
              </>
            ) : (
              <CategoryCarousel categories={categories} />
            )}
          </div>
        </div>
      </nav>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — Curated product grid (editorial spacing)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-smoke-50">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8 lg:py-16">
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
