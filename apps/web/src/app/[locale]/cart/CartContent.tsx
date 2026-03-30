'use client'

import React from 'react'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'

import { Heading, Text, Button, RadioGroup } from '@/components/atoms'
import { CartItem, Modal } from '@/components/molecules'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { apiFetch } from '@/lib/api'
import { formatBRL } from '@/lib/format'
import { track } from '@/domains/analytics'
export default function CartContent() {
  const t = useTranslations()
  const { items, deliveryType, couponCode, deliveryFee: storeDeliveryFee, getTotal, getItemCount, removeItem, updateItem, setDeliveryType } =
    useCartStore()
  const { addToast } = useUIStore()

  const [couponInput, setCouponInput] = React.useState(couponCode || '')
  const [showCouponModal, setShowCouponModal] = React.useState(false)
  const [couponDiscount, setCouponDiscount] = React.useState(0)

  const subtotal = getTotal()
  const deliveryFee = deliveryType === 'delivery' ? (storeDeliveryFee ?? 0) : 0
  const total = subtotal + deliveryFee - couponDiscount

  const handleApplyCoupon = async () => {
    if (!couponInput.trim()) return
    try {
      const res = await apiFetch<{ valid: boolean; discount?: number }>('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({ code: couponInput.toUpperCase() }),
      })
      if (res.valid) {
        useCartStore.getState().setCouponCode(couponInput.toUpperCase())
        setCouponDiscount(res.discount ?? 0)
        addToast(t('cart.coupon_applied', { code: couponInput }), 'success')
        setShowCouponModal(false)
      } else {
        addToast(t('cart.coupon_invalid'), 'error')
      }
    } catch {
      addToast(t('cart.coupon_error'), 'error')
    }
  }

  const handleCheckout = () => {
    if (!deliveryType) {
      addToast(t('cart.select_delivery_type'), 'warning')
      return
    }
    track('checkout_started', {
      cartTotal: total,
      itemCount: getItemCount(),
      deliveryType,
    })
    addToast(t('cart.checkout_progress'), 'success')
  }

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-smoke-50 flex flex-col items-center justify-center px-4">
        <Heading as="h1" variant="h2" className="mb-4 font-display">
          {t('cart.empty')}
        </Heading>
        <Text textColor="secondary" className="mb-8">
          {t('cart.empty_subtitle')}
        </Text>
        <Link href={"/search"}>
          <Button variant="brand" size="lg">
            {t('cart.back_to_menu')}
          </Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50">
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <Heading as="h1" variant="h2" className="font-display">
            {t('cart.title')} ({getItemCount()} {getItemCount() === 1 ? t('cart.item') : t('cart.items')})
          </Heading>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Cart Items */}
          <div className="lg:col-span-2 space-y-4">
            {items.map((item) => (
              <CartItem
                key={item.id}
                {...item}
                onQuantityChange={(quantity) => updateItem(item.id, { quantity })}
                onRemove={() => removeItem(item.id)}
              />
            ))}
          </div>

          {/* Summary Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-smoke-50 rounded-sm border border-smoke-200 p-6 sticky top-4 space-y-4">
              {/* Delivery Type */}
              <div>
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

              {/* Summary */}
              <div className="space-y-3 border-t border-smoke-200 pt-4">
                <div className="flex justify-between">
                  <Text textColor="secondary">{t('cart.subtotal')}</Text>
                  <Text className="font-semibold">
                    {formatBRL(subtotal)}
                  </Text>
                </div>

                {deliveryFee > 0 && (
                  <div className="flex justify-between">
                    <Text textColor="secondary">{t('cart.delivery_fee')}</Text>
                    <Text className="font-semibold">
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
              <div className="flex justify-between border-t border-smoke-200 pt-4">
                <Heading as="h4" variant="h4" className="font-display">
                  {t('cart.total')}
                </Heading>
                <Heading as="h4" variant="h4" className="font-display text-brand-600">
                  {formatBRL(total)}
                </Heading>
              </div>

              {/* Coupon Input */}
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={() => setShowCouponModal(true)}
              >
                {couponCode ? t('cart.coupon_applied_badge') : t('cart.add_coupon')}
              </Button>

              {/* Checkout Button */}
              <Button
                variant="brand"
                size="lg"
                className="w-full"
                onClick={handleCheckout}
                disabled={!deliveryType}
              >
                {t('cart.proceed_checkout')}
              </Button>

              {/* Continue Shopping */}
              <Link href={"/search"} className="block">
                <Button variant="tertiary" size="md" className="w-full">
                  {t('cart.back_to_menu')}
                </Button>
              </Link>
            </div>
          </div>
        </div>
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
            className="w-full px-4 py-2 border-0 border-b border-smoke-200 focus:border-charcoal-900 focus:outline-none transition-colors duration-500"
          />
          <Text variant="small" textColor="muted">
            {t('cart.coupon_hint')}
          </Text>
        </div>
      </Modal>
    </div>
  )
}
