'use client'

import React, { useMemo } from 'react'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { Heading, Text, Button, RadioGroup } from '@/components/atoms'
import { CartItem, Modal } from '@/components/molecules'
import { useCartStore, useUIStore } from '@/stores'
import { apiFetch } from '@/lib/api'
import clsx from 'clsx'

export default function CartPage() {
  const { items, deliveryType, couponCode, getTotal, getItemCount, removeItem, updateItem, setDeliveryType, clearCart } =
    useCartStore()
  const { addToast } = useUIStore()
  const locale = useLocale()

  const [couponInput, setCouponInput] = React.useState(couponCode || '')
  const [showCouponModal, setShowCouponModal] = React.useState(false)

  const subtotal = getTotal()
  const deliveryFee = deliveryType === 'delivery' ? 1000 : 0 // R$10
  const tax = Math.floor(subtotal * 0.1) // 10% tax
  const total = subtotal + deliveryFee + tax

  const handleApplyCoupon = async () => {
    if (!couponInput.trim()) return
    try {
      const res = await apiFetch('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({ code: couponInput.toUpperCase() }),
      })
      if (res.valid) {
        useCartStore.getState().setCouponCode(couponInput.toUpperCase())
        addToast(`Cupom "${couponInput}" aplicado!`, 'success')
        setShowCouponModal(false)
      } else {
        addToast('Cupom inválido', 'error')
      }
    } catch {
      addToast('Erro ao validar cupom', 'error')
    }
  }

  const handleCheckout = () => {
    if (!deliveryType) {
      addToast('Selecione um tipo de entrega', 'warning')
      return
    }
    // Navigate to checkout page
    // router.push(`/${locale}/checkout`)
    addToast('Prosseguindo para pagamento...', 'success')
  }

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4">
        <Heading as="h1" variant="h2" className="mb-4">
          Seu carrinho está vazio
        </Heading>
        <Text textColor="secondary" className="mb-8">
          Explore nosso menu e adicione seus pratos favoritos
        </Text>
        <Link href={`/${locale}/search`}>
          <Button variant="primary" size="lg">
            Voltar ao Menu
          </Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <Heading as="h1" variant="h2">
            Carrinho ({getItemCount()} {getItemCount() === 1 ? 'item' : 'itens'})
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
            <div className="bg-white rounded-lg border border-slate-200 p-6 sticky top-4 space-y-4">
              {/* Delivery Type */}
              <div>
                <Heading as="h3" variant="h5" className="mb-3">
                  Tipo de Entrega
                </Heading>
                <RadioGroup
                  name="deliveryType"
                  options={[
                    { value: 'delivery', label: 'Entrega em Casa', description: 'R$ 10,00' },
                    { value: 'pickup', label: 'Retirada no Local', description: 'Sem taxa' },
                    { value: 'dine-in', label: 'Comer no Local', description: 'Sem taxa' },
                  ]}
                  value={deliveryType || ''}
                  onChange={(value) => setDeliveryType(value as 'delivery' | 'pickup' | 'dine-in')}
                  layout="vertical"
                />
              </div>

              {/* Summary */}
              <div className="space-y-3 border-t border-slate-200 pt-4">
                <div className="flex justify-between">
                  <Text textColor="secondary">Subtotal</Text>
                  <Text className="font-semibold">
                    {(subtotal / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </Text>
                </div>

                <div className="flex justify-between">
                  <Text textColor="secondary">Taxa</Text>
                  <Text className="font-semibold">
                    {(tax / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </Text>
                </div>

                {deliveryFee > 0 && (
                  <div className="flex justify-between">
                    <Text textColor="secondary">Entrega</Text>
                    <Text className="font-semibold">
                      {(deliveryFee / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    </Text>
                  </div>
                )}

                {couponCode && (
                  <div className="flex justify-between bg-green-50 p-2 rounded text-green-700">
                    <Text variant="small">Cupom {couponCode}</Text>
                    <Text variant="small" className="font-semibold">
                      -R$ 10,00
                    </Text>
                  </div>
                )}
              </div>

              {/* Total */}
              <div className="flex justify-between border-t border-slate-200 pt-4">
                <Heading as="h4" variant="h4">
                  Total
                </Heading>
                <Heading as="h4" variant="h4" textColor="accent">
                  {(total / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                </Heading>
              </div>

              {/* Coupon Input */}
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={() => setShowCouponModal(true)}
              >
                {couponCode ? '✓ Cupom Aplicado' : 'Adicionar Cupom'}
              </Button>

              {/* Checkout Button */}
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handleCheckout}
                disabled={!deliveryType}
              >
                Ir para Pagamento
              </Button>

              {/* Continue Shopping */}
              <Link href={`/${locale}/search`} className="block">
                <Button variant="tertiary" size="md" className="w-full">
                  Voltar ao Menu
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Coupon Modal */}
      <Modal
        isOpen={showCouponModal}
        title="Aplicar Cupom"
        onClose={() => setShowCouponModal(false)}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setShowCouponModal(false)}>
              Cancelar
            </Button>
            <Button variant="primary" className="flex-1" onClick={handleApplyCoupon}>
              Aplicar
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <input
            type="text"
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            placeholder="Ex: WELCOME10"
            className="w-full px-4 py-2 border border-slate-300 rounded-lg"
          />
          <Text variant="small" textColor="muted">
            Insira o código do cupom promocional
          </Text>
        </div>
      </Modal>
    </div>
  )
}
