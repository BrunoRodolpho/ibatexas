'use client'

import { useTranslations } from 'next-intl'
import { ProductCarousel } from '@/components/organisms/ProductCarousel'
import { useProducts } from '@/hooks/api'
import { useUIStore } from '@/stores/useUIStore'
import { useCartStore } from '@/stores/useCartStore'
import { Button, HeroVideo, Heading, Text } from '@/components/atoms'
import type { ProductDTO } from '@ibatexas/types'

export default function Home() {
  const t = useTranslations()
  const setChat = useUIStore((s) => s.setChat)
  const addToast = useUIStore((s) => s.addToast)
  const addItem = useCartStore((s) => s.addItem)

  const { data: productsData, loading: productsLoading } = useProducts({ limit: 12 })

  const topProducts = productsData?.items ?? []

  const handleAddToCart = (productId: string) => {
    const product = topProducts.find((p) => p.id === productId)
    if (product) {
      const defaultVariant = product.variants?.[0]
      addItem(product as ProductDTO, 1, undefined, defaultVariant)
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
          SECTION 1 — Hero (layered composition, not grid)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="relative bg-smoke-50 overflow-hidden" data-hero>

        {/* Video — positioned as backdrop on the left (desktop only) */}
        <div className="hidden lg:block absolute top-4 bottom-0 left-[2%] w-[52%] pointer-events-none">
          <HeroVideo
            src="/videos/pitmaster-hero.mp4"
            poster="/videos/pitmaster-hero-placeholder.png"
            className="h-full w-full"
          />
        </div>

        {/* White gradient — fades video into white on the right */}
        <div className="hidden lg:block absolute inset-y-0 left-[34%] w-[28%] bg-gradient-to-r from-transparent to-smoke-50 pointer-events-none" />

        {/* Content layer */}
        <div className="relative mx-auto max-w-[1400px] px-6 sm:px-8 py-4 lg:pt-14 lg:pb-20 lg:min-h-[460px] lg:flex lg:items-start">

          {/* Mobile — video above text */}
          <div className="lg:hidden flex justify-center mb-2">
            <div className="w-[100%] sm:w-[85%]">
              <HeroVideo
                src="/videos/pitmaster-hero.mp4"
                poster="/videos/pitmaster-hero-placeholder.png"
                className="w-full"
              />
            </div>
          </div>

          {/* Text — centered on desktop, overlaps video edge */}
          <div className="text-center lg:text-left lg:ml-[46%] lg:max-w-[600px] animate-reveal">
            <Heading as="h1" className="font-display text-display-md sm:text-display-lg lg:text-display-xl font-bold text-brand-500 leading-[1.02] tracking-display">
              {t('home.hero_title')}
            </Heading>
            <Text className="mt-4 lg:mt-6 font-display italic text-xl sm:text-2xl text-smoke-400 leading-relaxed mx-auto lg:mx-0">
              {t('home.hero_subtitle')}
            </Text>
          </div>

        </div>

        {/* Bottom accent */}
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-smoke-200 to-transparent" />
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — Bold statement + infinite product carousel
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-smoke-50">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 pt-8 lg:pt-16 pb-4">
          {/* Section header — bold statement */}
          <div className="max-w-2xl">
            <Heading as="h2" className="font-display text-display-sm sm:text-display-md font-semibold text-charcoal-900 tracking-display leading-tight">
              {t('home.our_menu')}
            </Heading>
            <Text className="mt-4 text-sm sm:text-base text-smoke-400 leading-relaxed tracking-wide">
              {t('home.our_menu_subtitle')}
            </Text>
          </div>
        </div>

        {/* Carousel — full-bleed, hidden on small phones */}
        <div className="hidden sm:block pb-8 lg:pb-16">
          <ProductCarousel
            products={topProducts}
            isLoading={productsLoading}
          />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — Stats band (textured dark, editorial numbers)
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
          SECTION 4 — Closing CTA (quiet authority)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-smoke-100">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-20 lg:py-30">
          <div className="max-w-xl mx-auto text-center">
            <Heading as="h2" className="font-display text-display-sm sm:text-display-md font-semibold text-charcoal-900 leading-tight tracking-display">
              {t('home.cta_title')}
            </Heading>
            <Text className="mt-4 text-sm text-smoke-400 leading-relaxed measure-reading mx-auto">
              {t('home.cta_subtitle')}
            </Text>
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
