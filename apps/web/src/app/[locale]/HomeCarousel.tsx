'use client'

import { ScrollReveal } from '@/components/atoms'
import { ProductCarousel } from '@/components/organisms/ProductCarousel'
import { useProducts } from '@/domains/product'

export default function HomeCarousel() {
  const { data: productsData, loading: productsLoading } = useProducts({ limit: 12 })
  const topProducts = productsData?.items ?? []

  // Show a light spacer when no products (prevents orange→dark merge)
  if (!productsLoading && topProducts.length === 0) {
    return <div className="h-48 sm:h-60 lg:h-72 bg-smoke-50" />
  }

  // Rhythm note (2026-04): dropped the internal header block (eyebrow flame +
  // `section_menu` + `featured_products` + `featured_subtitle`). It duplicated
  // the orange brand statement immediately above — two headlines for the same
  // narrative beat. Padding snaps onto the canonical `default` scale from
  // Section.tsx (`py-16 lg:py-24`). The orange section above uses `loose`,
  // so the transition reads loose → default, which matches the narrative.
  return (
    <section className="relative bg-smoke-50 overflow-hidden warm-glow">
      <div className="relative py-16 lg:py-24">
        <ProductCarousel
          products={topProducts}
          isLoading={productsLoading}
        />
      </div>

      {/* Bottom decorative divider — transitions into the reviews section. */}
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
