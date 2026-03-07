'use client'

import { useTranslations } from 'next-intl'
import { Flame } from 'lucide-react'
import { Heading, Text, ScrollReveal } from '@/components/atoms'
import { ProductCarousel } from '@/components/organisms/ProductCarousel'
import { useProducts } from '@/domains/product'

export default function HomeCarousel() {
  const t = useTranslations()
  const { data: productsData, loading: productsLoading } = useProducts({ limit: 12 })
  const topProducts = productsData?.items ?? []

  // Show a light spacer when no products (prevents orange→dark merge)
  if (!productsLoading && topProducts.length === 0) {
    return <div className="h-48 sm:h-60 lg:h-72 bg-smoke-50" />
  }

  return (
    <section className="relative bg-smoke-50 overflow-hidden warm-glow">
      {/* Top decorative area */}
      <div className="relative pt-34 lg:pt-38">
        <ScrollReveal animation="fade-up" delay={100}>
          <div className="flex items-center justify-center gap-4 mb-8 lg:mb-10">
            <div className="h-px w-12 sm:w-20 bg-smoke-300/30" />
            <Flame className="w-4 h-4 text-brand-500/40" strokeWidth={1.5} />
            <div className="h-px w-12 sm:w-20 bg-smoke-300/30" />
          </div>
        </ScrollReveal>

        <ScrollReveal animation="fade-up" delay={200}>
          <p className="text-center text-[10px] uppercase tracking-editorial text-smoke-500 font-medium mb-3">
            {t('home.section_menu')}
          </p>
        </ScrollReveal>

        <ScrollReveal animation="scale-up" delay={350}>
          <Heading as="h2" className="font-display text-display-sm sm:text-display-md font-semibold text-charcoal-900 leading-tight tracking-display text-center max-w-[600px] mx-auto">
            {t('home.featured_products')}
          </Heading>
        </ScrollReveal>

        <ScrollReveal animation="fade-up" delay={500}>
          <Text className="mt-3 sm:mt-4 text-sm sm:text-base text-smoke-500 leading-relaxed font-display italic text-center max-w-[440px] mx-auto">
            {t('home.featured_subtitle')}
          </Text>
        </ScrollReveal>
      </div>

      {/* Carousel */}
      <div className="relative pt-12 lg:pt-16 pb-34 lg:pb-38">
        <ProductCarousel
          products={topProducts}
          isLoading={productsLoading}
        />
      </div>

      {/* Bottom decorative divider */}
      <ScrollReveal animation="fade-up" delay={100}>
        <div className="flex items-center justify-center gap-4 pb-6">
          <div className="h-px w-12 sm:w-20 bg-smoke-300/30" />
          <div className="w-1.5 h-1.5 rounded-full bg-smoke-400/40" />
          <div className="h-px w-12 sm:w-20 bg-smoke-300/30" />
        </div>
      </ScrollReveal>
    </section>
  )
}
