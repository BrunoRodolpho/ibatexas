'use client'

import { useTranslations } from 'next-intl'
import { ProductCarousel } from '@/components/organisms/ProductCarousel'
import { useProducts } from '@/domains/product'
import { useUIStore } from '@/domains/ui'
import { useCartStore } from '@/domains/cart'
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
