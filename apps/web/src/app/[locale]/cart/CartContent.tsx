'use client'

import React from 'react'
import { Link, useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'

import { Heading, Text, Button, RadioGroup, Container, LinkButton } from '@/components/atoms'
import { CartItem, Modal } from '@/components/molecules'
import { KitchenClosedBanner } from '@/components/molecules/KitchenClosedBanner'
import { useCartStore, hasKitchenOnlyFood, getKitchenItems } from '@/domains/cart'
import { useKitchenStatus } from '@/domains/schedule'
import { useUIStore } from '@/domains/ui'
import { useRecommendations, type RecommendedProduct } from '@/domains/recommendations'
import { apiFetch } from '@/lib/api'
import { formatBRL } from '@/lib/format'
import { FREE_DELIVERY_THRESHOLD } from '@/lib/constants'
import { track } from '@/domains/analytics'
import { ShoppingBag, Check, Plus } from 'lucide-react'
import NextImage from 'next/image'
export default function CartContent() {
  const t = useTranslations()
  const router = useRouter()
  const { items, deliveryType, couponCode, deliveryFee: storeDeliveryFee, getTotal, getItemCount, removeItem, updateItem, addItem, setDeliveryType } =
    useCartStore()
  const { addToast } = useUIStore()
  const { data: kitchenStatus } = useKitchenStatus()
  const { data: recommendations } = useRecommendations(6)
  const isKitchenClosed = kitchenStatus?.mealPeriod === 'closed'
  const cartHasKitchenFood = hasKitchenOnlyFood(items)
  const kitchenItems = getKitchenItems(items)

  const [couponInput, setCouponInput] = React.useState(couponCode || '')
  const [showCouponModal, setShowCouponModal] = React.useState(false)
  const [couponDiscount, setCouponDiscount] = React.useState(0)

  const subtotal = getTotal()
  const deliveryFee = deliveryType === 'delivery' ? (storeDeliveryFee ?? 0) : 0
  const total = subtotal + deliveryFee - couponDiscount

  // Cross-sell: exclude items already in cart
  const cartProductIds = new Set(items.map((i) => i.productId))
  const crossSellItems = (recommendations ?? []).filter((r) => !cartProductIds.has(r.id)).slice(0, 6)

  const handleCrossSellAdd = (rec: RecommendedProduct) => {
    const minimalProduct = {
      id: rec.id,
      title: rec.title,
      price: rec.price,
      imageUrl: rec.imageUrl ?? null,
      variants: [],
    } as unknown as import('@ibatexas/types').ProductDTO
    addItem(minimalProduct, 1)
    track('cross_sell_added', { productId: rec.id, source: 'cart_page' })
    addToast(`${rec.title} — ${t('toast.added_to_cart')}`, 'cart')
  }

  const handleApplyCoupon = async () => {
    if (!couponInput.trim()) return
    const code = couponInput.toUpperCase()
    try {
      const res = await apiFetch<{ valid: boolean; discount?: number }>('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
      if (res.valid) {
        useCartStore.getState().setCouponCode(code)
        setCouponDiscount(res.discount ?? 0)
        addToast(t('cart.coupon_applied', { code: couponInput }), 'success')
        setShowCouponModal(false)
      } else {
        track('coupon_validation_failed', { code, reason: 'invalid' })
        addToast(t('cart.coupon_invalid'), 'error')
      }
    } catch {
      track('coupon_validation_failed', { code, reason: 'error' })
      addToast(t('cart.coupon_error'), 'error')
    }
  }

  const handleCheckout = () => {
    // Store default is 'delivery' (see cart.store.ts). We still guard here
    // for persisted-null legacy sessions, but the CTA is no longer disabled.
    if (!deliveryType) {
      setDeliveryType('delivery')
    }
    track('checkout_started', {
      cartTotal: total,
      itemCount: getItemCount(),
      deliveryType,
    })
    addToast(t('cart.checkout_progress'), 'success')
    router.push('/checkout')
  }

  if (items.length === 0) {
    return (
      <div className="bg-smoke-50">
        <Container padding="tight" className="py-24">
          <div className="flex flex-col items-center justify-center gap-6">
            <div className="w-20 h-20 rounded-full bg-smoke-100 flex items-center justify-center">
              <ShoppingBag className="w-9 h-9 text-smoke-300" strokeWidth={1.5} />
            </div>
            <div className="text-center">
              <Heading as="h1" variant="h3" className="font-display mb-2">
                {t('cart.empty')}
              </Heading>
              <Text textColor="muted" className="text-sm">
                {t('cart.empty_subtitle')}
              </Text>
            </div>
            <div className="flex gap-3">
              <LinkButton href="/search" variant="brand" size="lg">
                {t('cart.explore_menu')}
              </LinkButton>
              <LinkButton href="/" variant="tertiary" size="lg">
                {t('cart.back_to_menu')}
              </LinkButton>
            </div>
          </div>

          {/* Recommendations for empty cart */}
          {crossSellItems.length > 0 && (
            <div className="mt-16">
              <div className="h-px w-16 bg-smoke-200 mx-auto mb-8" />
              <p className="text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] text-center mb-6">
                {t('cart.you_might_like')}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {crossSellItems.map((rec) => (
                  <div
                    key={rec.id}
                    className="surface-card rounded-card overflow-hidden flex flex-col"
                  >
                    <div className="relative aspect-square bg-smoke-100">
                      {rec.imageUrl && (
                        <NextImage
                          src={rec.imageUrl}
                          alt={rec.title}
                          fill
                          sizes="(max-width: 768px) 50vw, 33vw"
                          className="object-cover"
                        />
                      )}
                    </div>
                    <div className="p-3 flex flex-col flex-1">
                      <p className="text-sm font-medium text-charcoal-900 leading-snug line-clamp-2 min-h-[2.5rem]">
                        {rec.title}
                      </p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-sm font-semibold text-charcoal-900 tabular-nums">
                          {formatBRL(rec.price)}
                        </span>
                        <button
                          onClick={() => handleCrossSellAdd(rec)}
                          className="min-w-[44px] min-h-[44px] w-9 h-9 flex items-center justify-center rounded-full bg-brand-500 text-white hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury"
                          aria-label={`${t('cart.add_suggestion')} ${rec.title}`}
                        >
                          <Plus className="w-4 h-4" strokeWidth={2.5} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Container>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50">
      {/* pb-32 lg:pb-6 leaves room for the mobile sticky CTA below. */}
      <Container padding="tight" className="py-6 pb-32 lg:py-8 lg:pb-6">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left column: title + items */}
          <div className="lg:col-span-2">
            <div className="mb-4">
              <Heading as="h1" variant="h2" className="font-display">
                {t('cart.title')} ({getItemCount()} {getItemCount() === 1 ? t('cart.item') : t('cart.items')})
              </Heading>
              <Text className="mt-1 font-display italic text-smoke-400 text-sm">
                {t('cart.subtitle')}
              </Text>
            </div>

            {/* Kitchen closed warning */}
            {isKitchenClosed && cartHasKitchenFood && kitchenStatus?.nextOpenDay && (
              <div className="mb-4">
                <KitchenClosedBanner
                  nextOpenDay={kitchenStatus.nextOpenDay}
                  kitchenItems={kitchenItems}
                />
              </div>
            )}

            {items.map((item) => (
              <CartItem
                key={item.id}
                {...item}
                isKitchenClosed={isKitchenClosed}
                onQuantityChange={(quantity) => updateItem(item.id, { quantity })}
                onRemove={() => removeItem(item.id)}
              />
            ))}
          </div>

          {/* Right sidebar — starts at top, sticky */}
          <div className="lg:col-span-1">
            <div className="relative bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 sticky top-[72px] space-y-4 overflow-hidden">
              <div className="absolute inset-0 warm-glow pointer-events-none opacity-40" />

              {/* Delivery Type */}
              <div className="relative">
                <Heading as="h3" variant="h5" className="mb-3">
                  {t('cart.delivery_type')}
                </Heading>
                <RadioGroup
                  name="deliveryType"
                  options={[
                    { value: 'delivery', label: t('cart.delivery'), description: t('cart.delivery_fee_label') },
                    { value: 'pickup', label: t('cart.pickup'), description: t('cart.pickup_fee_label') },
                    { value: 'dine-in', label: t('cart.dine_in'), description: t('cart.dine_in_fee_label') },
                  ]}
                  value={deliveryType || ''}
                  onChange={(value) => setDeliveryType(value as 'delivery' | 'pickup' | 'dine-in')}
                  layout="vertical"
                />
              </div>

              {/* Free delivery progress */}
              {deliveryType === 'delivery' && (
                <div className="relative border-t border-smoke-200 pt-4">
                  <div className="h-1.5 w-full rounded-full bg-smoke-200 overflow-hidden">
                    <div
                      className="h-full bg-brand-500 transition-all duration-700 ease-luxury rounded-full"
                      style={{ width: `${Math.min((subtotal / FREE_DELIVERY_THRESHOLD) * 100, 100)}%` }}
                    />
                  </div>
                  {subtotal < FREE_DELIVERY_THRESHOLD ? (
                    <p className="text-xs text-smoke-400 mt-1.5">
                      {t('sticky_cart.free_delivery_progress', { remaining: formatBRL(FREE_DELIVERY_THRESHOLD - subtotal) })}
                    </p>
                  ) : (
                    <p className="text-xs text-brand-600 mt-1.5 flex items-center gap-1">
                      <Check className="w-3 h-3" strokeWidth={2.5} />
                      {t('sticky_cart.free_delivery_reached')}
                    </p>
                  )}
                </div>
              )}

              {/* Summary */}
              <div className="relative space-y-3 border-t border-smoke-200 pt-4">
                <div className="flex justify-between">
                  <Text textColor="secondary">{t('cart.subtotal')}</Text>
                  <Text className="font-semibold tabular-nums">
                    {formatBRL(subtotal)}
                  </Text>
                </div>

                {deliveryFee > 0 && (
                  <div className="flex justify-between">
                    <Text textColor="secondary">{t('cart.delivery_fee')}</Text>
                    <Text className="font-semibold tabular-nums">
                      {formatBRL(deliveryFee)}
                    </Text>
                  </div>
                )}

                {couponCode && couponDiscount > 0 && (
                  <div className="flex justify-between bg-accent-green/10 p-2 rounded text-accent-green">
                    <Text variant="small">{t('cart.coupon_applied_badge')} ({couponCode})</Text>
                    <Text variant="small" className="font-semibold">
                      -{formatBRL(couponDiscount)}
                    </Text>
                  </div>
                )}
              </div>

              {/* Total */}
              <div className="relative flex justify-between items-baseline border-t border-smoke-200 pt-4">
                <span className="font-display text-display-2xs font-bold text-charcoal-900">
                  {t('cart.total')}
                </span>
                <span className="font-display text-display-2xs font-bold text-brand-600 tabular-nums">
                  {formatBRL(total)}
                </span>
              </div>

              {/* Coupon Input */}
              <Button
                variant="secondary"
                size="md"
                className="relative w-full"
                onClick={() => setShowCouponModal(true)}
              >
                {couponCode ? t('cart.coupon_applied_badge') : t('cart.add_coupon')}
              </Button>

              {/* Checkout Button */}
              <Button
                variant="brand"
                size="lg"
                className="relative w-full"
                onClick={handleCheckout}
              >
                {t('cart.proceed_checkout')}
              </Button>

              {/* Continue Shopping */}
              <Link href={"/search"} className="relative block">
                <Button variant="tertiary" size="md" className="w-full">
                  {t('cart.back_to_menu')}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </Container>

      {/*
        Mobile sticky checkout bar — pinned bottom on < lg.
        Desktop already has the sidebar with `sticky top-4`, but on mobile the
        sidebar collapses below the items list, putting the checkout button
        far below the fold. This bar surfaces total + CTA at all times.
      */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-smoke-50 border-t border-smoke-200 shadow-[0_-12px_28px_-16px_rgba(0,0,0,0.18)]">
        <Container padding="tight" className="py-3 flex items-center gap-3">
          <div className="flex flex-col">
            <Text variant="small" textColor="muted">
              {t('cart.total')}
            </Text>
            <span className="text-price leading-none">
              {formatBRL(total)}
            </span>
          </div>
          <Button
            variant="brand"
            size="lg"
            className="flex-1"
            onClick={handleCheckout}
          >
            {t('cart.proceed_checkout')}
          </Button>
        </Container>
      </div>

      {/* Coupon Modal */}
      <Modal
        isOpen={showCouponModal}
        title={t('cart.apply_coupon')}
        onClose={() => setShowCouponModal(false)}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setShowCouponModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="brand" className="flex-1" onClick={handleApplyCoupon}>
              {t('cart.apply')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <input
            type="text"
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            placeholder={t('cart.coupon_placeholder')}
            aria-label={t('cart.coupon_placeholder')}
            className="w-full px-4 py-2 border-0 border-b border-smoke-300 bg-transparent rounded-none shadow-xs focus:border-charcoal-900 focus:shadow-card focus:outline-none transition-[border-color,box-shadow] duration-[200ms] ease-luxury"
          />
          <Text variant="small" textColor="muted">
            {t('cart.coupon_hint')}
          </Text>
        </div>
      </Modal>
    </div>
  )
}
