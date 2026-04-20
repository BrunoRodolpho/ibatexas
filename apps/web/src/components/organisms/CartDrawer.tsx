'use client'

import { useTranslations } from 'next-intl'
import { useCartStore, hasKitchenOnlyFood, getKitchenItems } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { useKitchenStatus } from '@/domains/schedule'
import { Sheet } from '../molecules/Modal'
import { LinkButton, Text } from '../atoms'
import { Link } from '@/i18n/navigation'
import { QuantitySelector } from '../molecules/QuantitySelector'
import { Trash2, Plus, ShoppingBag } from 'lucide-react'
import NextImage from 'next/image'
import { track, trackOnceVisible } from '@/domains/analytics'
import { useEffect, useRef } from 'react'
import { KitchenClosedBanner } from '../molecules/KitchenClosedBanner'
import { formatBRL } from '@/lib/format'
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
  const { data: kitchenStatus } = useKitchenStatus()
  const isKitchenClosed = kitchenStatus?.mealPeriod === 'closed'
  const cartHasKitchenFood = hasKitchenOnlyFood(items)
  const kitchenItems = getKitchenItems(items)

  const itemCount = getItemCount()
  const subtotal = getTotal()
  const subtotalFormatted = formatBRL(subtotal)

  const handleCheckout = () => {
    track('checkout_started', { cartTotal: subtotal, itemCount })
    closeCartDrawer()
  }

  // Cross-sell: exclude items already in cart
  const cartProductIds = new Set(items.map((i) => i.productId))
  const crossSellItems = (recommendations ?? []).filter((r) => !cartProductIds.has(r.id)).slice(0, 3)

  // Impression tracking for the drawer cross-sell scroller. Fires once per
  // drawer open when the scroller actually has items to show — gives
  // `cross_sell_added` from this surface a CTR denominator.
  const crossSellRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen || !crossSellRef.current || crossSellItems.length === 0) return
    return trackOnceVisible(crossSellRef.current, 'cart_drawer_cross_sell_viewed', {
      count: crossSellItems.length,
      productIds: crossSellItems.map((r) => r.id),
    })
  }, [isOpen, crossSellItems])

  // Track kitchen-closed banner impression (once per drawer open)
  const kitchenBannerTrackedRef = useRef(false)
  useEffect(() => {
    if (isOpen && isKitchenClosed && cartHasKitchenFood && !kitchenBannerTrackedRef.current) {
      kitchenBannerTrackedRef.current = true
      track('kitchen_closed_banner_viewed', { source: 'cart_drawer', kitchenItemCount: kitchenItems.length })
    }
    if (!isOpen) kitchenBannerTrackedRef.current = false
  }, [isOpen, isKitchenClosed, cartHasKitchenFood, kitchenItems.length])

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

            {/* Kitchen closed warning */}
            {isKitchenClosed && cartHasKitchenFood && kitchenStatus?.nextOpenDay && (
              <KitchenClosedBanner
                nextOpenDay={kitchenStatus.nextOpenDay}
                kitchenItems={kitchenItems}
                compact
              />
            )}

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
        <div className="flex flex-col items-center justify-center py-12 gap-6">
          <div className="w-16 h-16 rounded-full bg-smoke-100 flex items-center justify-center">
            <ShoppingBag className="w-7 h-7 text-smoke-300" strokeWidth={1.5} />
          </div>
          <div className="text-center">
            <p className="font-display text-lg text-charcoal-900 tracking-display mb-1">
              {t('empty')}
            </p>
            <p className="text-sm text-smoke-400">
              {t('empty_subtitle')}
            </p>
          </div>
          <LinkButton
            href="/search"
            variant="brand"
            size="md"
            onClick={closeCartDrawer}
          >
            {t('explore_menu')}
          </LinkButton>

          {/* Recommendations for empty cart — inspiration to start shopping */}
          {crossSellItems.length > 0 && (
            <>
              <div className="h-px w-16 bg-smoke-200" />
              <div className="w-full">
                <p className="text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-3">
                  {t('you_might_like')}
                </p>
                <div className="-mx-4 px-4 flex gap-3 overflow-x-auto scrollbar-hide snap-x snap-mandatory">
                  {crossSellItems.map((rec) => (
                    <div
                      key={rec.id}
                      className="snap-start flex-shrink-0 w-[148px] surface-card rounded-card overflow-hidden flex flex-col"
                    >
                      <div className="relative aspect-square bg-smoke-100">
                        {rec.imageUrl && (
                          <NextImage
                            src={rec.imageUrl}
                            alt={rec.title}
                            fill
                            sizes="148px"
                            className="object-cover"
                          />
                        )}
                      </div>
                      <div className="p-2.5 flex flex-col flex-1">
                        <p className="text-xs font-medium text-charcoal-900 leading-snug line-clamp-2 min-h-[2.25rem]">
                          {rec.title}
                        </p>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-xs font-semibold text-charcoal-900 tabular-nums">
                            {formatBRL(rec.price)}
                          </span>
                          <button
                            onClick={() => handleCrossSellAdd(rec)}
                            className="min-w-[44px] min-h-[44px] w-9 h-9 flex items-center justify-center rounded-full bg-brand-500 text-white hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury"
                            aria-label={`${t('add_suggestion')} ${rec.title}`}
                          >
                            <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {/* Cart items — compact layout */}
          {items.map((item, index) => {
            const lineTotal = formatBRL(item.price * item.quantity)

            return (
              <div
                key={item.id}
                className={`flex gap-3 pb-3 border-b border-smoke-200 last:border-0 opacity-0 animate-slide-up ${isKitchenClosed && item.productType === 'food' ? 'opacity-50' : ''}`}
                style={{ animationDelay: `${index * 40}ms`, animationFillMode: 'forwards' }}
              >
                {/* Thumbnail — 64px, clickable to PDP */}
                <Link
                  href={`/loja/produto/${item.productId}`}
                  onClick={closeCartDrawer}
                  className="flex-shrink-0"
                >
                  <div className="w-16 h-16 rounded-sm overflow-hidden bg-smoke-100">
                    {item.imageUrl ? (
                      <NextImage
                        src={item.imageUrl}
                        alt={item.title}
                        width={64}
                        height={64}
                        placeholder="blur"
                        blurDataURL="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjEwIj48cmVjdCBmaWxsPSIjZThlNGUwIiB3aWR0aD0iOCIgaGVpZ2h0PSIxMCIvPjwvc3ZnPg=="
                        className="object-cover w-full h-full"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <ShoppingBag className="w-5 h-5 text-smoke-300" strokeWidth={1.5} />
                      </div>
                    )}
                  </div>
                </Link>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-1">
                    <Link
                      href={`/loja/produto/${item.productId}`}
                      onClick={closeCartDrawer}
                      className="min-w-0"
                    >
                      <h4 className="text-xs font-medium text-charcoal-900 truncate hover:text-brand-600 transition-colors duration-300">
                        {item.title}
                      </h4>
                    </Link>
                    <span className="text-xs font-semibold text-charcoal-900 tabular-nums flex-shrink-0">
                      {lineTotal}
                    </span>
                  </div>
                  {item.variantTitle && (
                    <p className="text-xs text-[var(--color-text-secondary)]">{item.variantTitle}</p>
                  )}
                  {isKitchenClosed && item.productType === 'food' && (
                    <span className="inline-block text-micro font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-sm mt-0.5">
                      {t('item_unavailable')}
                    </span>
                  )}
                  <div className="flex items-center gap-1 mt-1">
                    <button
                      onClick={() => removeItem(item.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-sm border border-smoke-200 text-[var(--color-text-secondary)] hover:text-accent-red hover:border-accent-red/30 transition-colors duration-300"
                      aria-label={t('remove_item', { title: item.title })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <QuantitySelector
                      quantity={item.quantity}
                      onQuantityChange={(qty) => updateItem(item.id, { quantity: qty })}
                      min={1}
                      max={99}
                      size="xs"
                    />
                  </div>
                </div>
              </div>
            )
          })}

          {/*
            Cross-sell — horizontal scroller of properly sized cards.
            Was a vertical stack of 40×40 thumbnails, easy to miss. The new
            layout gives each suggestion a real product card moment with
            image, title, price, and a tappable + button.
          */}
          {crossSellItems.length > 0 && (
            <div ref={crossSellRef} className="pt-4 mt-2 border-t border-smoke-200">
              <p className="text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-3">
                {t('you_might_like')}
              </p>
              <div className="-mx-4 px-4 flex gap-3 overflow-x-auto scrollbar-hide snap-x snap-mandatory">
                {crossSellItems.map((rec) => (
                  <div
                    key={rec.id}
                    className="snap-start flex-shrink-0 w-[148px] surface-card rounded-card overflow-hidden flex flex-col"
                  >
                    <div className="relative aspect-square bg-smoke-100">
                      {rec.imageUrl && (
                        <NextImage
                          src={rec.imageUrl}
                          alt={rec.title}
                          fill
                          sizes="148px"
                          className="object-cover"
                        />
                      )}
                    </div>
                    <div className="p-2.5 flex flex-col flex-1">
                      <p className="text-xs font-medium text-charcoal-900 leading-snug line-clamp-2 min-h-[2.25rem]">
                        {rec.title}
                      </p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-xs font-semibold text-charcoal-900 tabular-nums">
                          {formatBRL(rec.price)}
                        </span>
                        <button
                          onClick={() => handleCrossSellAdd(rec)}
                          className="min-w-[44px] min-h-[44px] w-9 h-9 flex items-center justify-center rounded-full bg-brand-500 text-white hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury"
                          aria-label={`${t('add_suggestion')} ${rec.title}`}
                        >
                          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                      </div>
                    </div>
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
