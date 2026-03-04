'use client'

import { useTranslations } from 'next-intl'
import { ProductCarousel } from '@/components/organisms/ProductCarousel'
import { useProducts } from '@/hooks/api'
import { useUIStore } from '@/stores/useUIStore'
import { useCartStore } from '@/stores/useCartStore'
import type { ProductDTO } from '@ibatexas/types'

export default function HomeCarousel() {
  const t = useTranslations()
  const addToast = useUIStore((s) => s.addToast)
  const addItem = useCartStore((s) => s.addItem)

  const { data: productsData, loading: productsLoading } = useProducts({ limit: 12 })
  const topProducts = productsData?.items ?? []

  return (
    <ProductCarousel
      products={topProducts}
      isLoading={productsLoading}
    />
  )
}
