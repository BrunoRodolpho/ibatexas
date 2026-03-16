'use client'

import { useTranslations } from 'next-intl'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { Sheet } from '../molecules/Modal'
import { Button, LinkButton, Heading, Text } from '../atoms'
import { QuantitySelector } from '../molecules/QuantitySelector'
import { Trash2, Plus } from 'lucide-react'
import NextImage from 'next/image'
import { track } from '@/domains/analytics'
import { useRecommendations, type RecommendedProduct } from '@/domains/recommendations'
import type { ProductDTO } from '@ibatexas/types'

export function CartDrawer() {
  const t = useTranslations('cart')
  const tToast = useTranslations('toast')
  const isOpen = useUIStore((s) => s.isCartDrawerOpen)
  const closeCartDrawer = useUIStore((s) => s.closeCartDrawer)
  const { addToast } = useUIStore()
  const { items, removeItem, updateItem, addItem, getTotal, getItemCount } = useCartStore()
  const { data: recommendations } = useRecommendations(3)

  const itemCount = getItemCount()
  const subtotal = getTotal()
  const subtotalFormatted = (subtotal / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  const handleCheckout = () => {
    track('checkout_started', { cartTotal: subtotal, itemCount })
    closeCartDrawer()
  }

  // Cross-sell: exclude items already in cart
  const cartProductIds = new Set(items.map((i) => i.productId))
  const crossSellItems = (recommendations ?? []).filter((r) => !cartProductIds.has(r.id)).slice(0, 3)

  const handleCrossSellAdd = (rec: RecommendedProduct) => {
    const minimalProduct = {
      id: rec.id,
      title: rec.title,
      price: rec.price,
      imageUrl: rec.imageUrl ?? null,
      variants: [],
    } as unknown as ProductDTO
    addItem(minimalProduct, 1)
    track('cross_sell_added', { productId: rec.id, source: 'cart_drawer' })
    addToast(`${rec.title} — ${tToast('added_to_cart')}`, 'cart')
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={closeCartDrawer}
      title={t('drawer_title', { count: itemCount })}
      position="right"
      footer={
        items.length > 0 ? (
          <div className="space-y-3">
            {/* Subtotal */}
            <div className="flex items-center justify-between">
              <Text variant="body" weight="medium" className="text-charcoal-900">
                {t('subtotal')}
              </Text>
              <Text variant="body" weight="semibold" className="text-charcoal-900 tabular-nums">
                {subtotalFormatted}
              </Text>
            </div>

            {/* Checkout CTA — goes directly to /checkout */}
            <LinkButton
              href="/checkout"
              variant="primary"
              size="lg"
              className="w-full"
              onClick={handleCheckout}
            >
              {t('checkout')}
            </LinkButton>

            {/* View full cart link */}
            <LinkButton
              href="/cart"
              variant="tertiary"
              size="md"
              className="w-full"
              onClick={closeCartDrawer}
            >
              {t('view_full_cart')}
            </LinkButton>
          </div>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-16 h-px bg-smoke-200" />
          <Text variant="body" textColor="muted" className="font-display text-lg text-center">
            {t('empty')}
          </Text>
          <div className="w-16 h-px bg-smoke-200" />
          <LinkButton
            href="/search"
            variant="brand"
            size="md"
            onClick={closeCartDrawer}
          >
            {t('explore_menu')}
          </LinkButton>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Cart items — compact layout */}
          {items.map((item, index) => {
            const lineTotal = ((item.price * item.quantity) / 100).toLocaleString('pt-BR', {
              style: 'currency',
              currency: 'BRL',
            })

            return (
              <div
                key={item.id}
                className="flex gap-2 pb-2 border-b border-smoke-200 last:border-0 opacity-0 animate-slide-up"
                style={{ animationDelay: `${index * 40}ms`, animationFillMode: 'forwards' }}
              >
                {/* Thumbnail — compact 48px */}
                {item.imageUrl && (
                  <div className="w-12 h-12 flex-shrink-0 rounded-sm overflow-hidden bg-smoke-100">
                    <NextImage
                      src={item.imageUrl}
                      alt={item.title}
                      width={48}
                      height={48}
                      placeholder="blur"
                      blurDataURL="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjEwIj48cmVjdCBmaWxsPSIjZThlNGUwIiB3aWR0aD0iOCIgaGVpZ2h0PSIxMCIvPjwvc3ZnPg=="
                      className="object-cover w-full h-full"
                    />
                  </div>
                )}

                {/* Details — compact: title+price on one row, quantity inline */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-1">
                    <h4 className="text-xs font-medium text-charcoal-900 truncate">
                      {item.title}
                    </h4>
                    <button
                      onClick={() => removeItem(item.id)}
                      className="min-w-[36px] min-h-[44px] -mt-2 flex items-center justify-center text-smoke-400 hover:text-accent-red transition-colors duration-300"
                      aria-label={t('remove_item', { title: item.title })}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  {item.variantTitle && (
                    <p className="text-[11px] text-smoke-400 -mt-0.5">{item.variantTitle}</p>
                  )}
                  <div className="flex items-center justify-between mt-0.5">
                    <QuantitySelector
                      quantity={item.quantity}
                      onQuantityChange={(qty) => updateItem(item.id, { quantity: qty })}
                      min={1}
                      max={99}
                      size="sm"
                    />
                    <span className="text-xs font-semibold text-charcoal-900 tabular-nums">
                      {lineTotal}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Cross-sell suggestions — below items */}
          {crossSellItems.length > 0 && (
            <div className="pt-2 border-t border-smoke-200">
              <p className="text-[11px] font-semibold uppercase tracking-editorial text-smoke-400 mb-3">
                {t('you_might_like')}
              </p>
              <div className="space-y-2">
                {crossSellItems.map((rec) => (
                  <div key={rec.id} className="flex items-center gap-2.5">
                    {rec.imageUrl && (
                      <div className="w-10 h-10 flex-shrink-0 rounded-sm overflow-hidden bg-smoke-100">
                        <NextImage src={rec.imageUrl} alt={rec.title} width={40} height={40} className="object-cover w-full h-full" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-charcoal-900 truncate">{rec.title}</p>
                      <p className="text-xs text-smoke-400 tabular-nums">
                        {(rec.price / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                      </p>
                    </div>
                    <button
                      onClick={() => handleCrossSellAdd(rec)}
                      className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-sm border border-smoke-200 text-smoke-400 hover:border-brand-500 hover:text-brand-600 transition-colors"
                      aria-label={`${t('add_suggestion')} ${rec.title}`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
