'use client'

import { useTranslations } from 'next-intl'
import { useOrderHistory } from '@/domains/cart/useOrderHistory'
import { useCartStore } from '@/domains/cart'
import { useSessionStore } from '@/domains/session'
import { useUIStore } from '@/domains/ui'
import { Button } from '../atoms/Button'
import { track } from '@/domains/analytics'
import NextImage from 'next/image'
import type { ProductDTO } from '@ibatexas/types'

export function ReorderCard() {
  const t = useTranslations('reorder')
  const { lastOrder } = useOrderHistory()
  const { isAuthenticated } = useSessionStore()
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  if (!lastOrder || !isAuthenticated() || lastOrder.items.length === 0) return null

  const handleReorder = () => {
    for (const item of lastOrder.items) {
      const minimalProduct = {
        id: item.productId,
        title: item.title,
        price: item.price,
        imageUrl: item.imageUrl ?? null,
        variants: item.variantId ? [{ id: item.variantId, title: item.variantTitle, price: item.price }] : [],
      } as unknown as ProductDTO
      const variant = item.variantId ? { id: item.variantId, title: item.variantTitle ?? '', price: item.price, sku: null } : undefined
      addItem(minimalProduct, item.quantity, undefined, variant)
    }
    track('reorder_completed', { orderId: lastOrder.orderId, itemCount: lastOrder.items.length })
    addToast(t('added_all'), 'cart')
  }

  const totalFormatted = (lastOrder.total / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  return (
    <section className="bg-smoke-50">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-8">
        <div className="border border-smoke-200 rounded-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-display text-sm font-semibold text-charcoal-900">{t('title')}</h3>
              <p className="text-xs text-smoke-400">{t('subtitle', { total: totalFormatted })}</p>
            </div>
            <Button variant="brand" size="sm" onClick={handleReorder}>
              {t('cta')}
            </Button>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {lastOrder.items.slice(0, 4).map((item) => (
              <div key={item.productId + (item.variantId || '')} className="flex-shrink-0">
                {item.imageUrl ? (
                  <div className="w-12 h-12 rounded-sm overflow-hidden bg-smoke-100">
                    <NextImage src={item.imageUrl} alt={item.title} width={48} height={48} className="object-cover w-full h-full" />
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-sm bg-smoke-100 flex items-center justify-center">
                    <span className="text-[8px] text-smoke-300">IBX</span>
                  </div>
                )}
              </div>
            ))}
            {lastOrder.items.length > 4 && (
              <div className="w-12 h-12 rounded-sm bg-smoke-100 flex items-center justify-center flex-shrink-0">
                <span className="text-xs text-smoke-400">+{lastOrder.items.length - 4}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
