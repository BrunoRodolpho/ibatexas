'use client'

import { useCartStore, useUIStore } from '@/stores'
import { Sheet } from '../molecules/Modal'
import { Button, LinkButton } from '../atoms/Button'
import { Heading, Text } from '../atoms/Typography'
import { QuantitySelector } from '../molecules/QuantitySelector'
import { Trash2 } from 'lucide-react'
import NextImage from 'next/image'
import { track } from '@/lib/analytics'

export function CartDrawer() {
  const isOpen = useUIStore((s) => s.isCartDrawerOpen)
  const closeCartDrawer = useUIStore((s) => s.closeCartDrawer)
  const { items, removeItem, updateItem, getTotal, getItemCount } = useCartStore()

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

  return (
    <Sheet
      isOpen={isOpen}
      onClose={closeCartDrawer}
      title={`Seu carrinho (${itemCount} ${itemCount === 1 ? 'item' : 'itens'})`}
      position="right"
      footer={
        items.length > 0 ? (
          <div className="space-y-3">
            {/* Subtotal */}
            <div className="flex items-center justify-between">
              <Text variant="body" weight="medium" className="text-charcoal-900">
                Subtotal
              </Text>
              <Text variant="body" weight="semibold" className="text-charcoal-900 tabular-nums">
                {subtotalFormatted}
              </Text>
            </div>

            {/* Checkout CTA */}
            <LinkButton
              href="/cart"
              variant="primary"
              size="lg"
              className="w-full"
              onClick={handleCheckout}
            >
              Finalizar pedido
            </LinkButton>

            {/* View full cart link */}
            <LinkButton
              href="/cart"
              variant="tertiary"
              size="md"
              className="w-full"
              onClick={closeCartDrawer}
            >
              Ver carrinho completo
            </LinkButton>
          </div>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-16 h-px bg-smoke-200" />
          <Text variant="body" textColor="muted" className="font-display text-lg text-center">
            Seu carrinho está vazio
          </Text>
          <div className="w-16 h-px bg-smoke-200" />
          <LinkButton
            href="/search"
            variant="brand"
            size="md"
            onClick={closeCartDrawer}
          >
            Explorar cardápio
          </LinkButton>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const lineTotal = ((item.price * item.quantity) / 100).toLocaleString('pt-BR', {
              style: 'currency',
              currency: 'BRL',
            })

            return (
              <div
                key={item.id}
                className="flex gap-3 pb-4 border-b border-smoke-200 last:border-0"
              >
                {/* Thumbnail */}
                {item.imageUrl && (
                  <div className="w-16 h-16 flex-shrink-0 rounded-sm overflow-hidden bg-smoke-100">
                    <NextImage
                      src={item.imageUrl}
                      alt={item.title}
                      width={64}
                      height={64}
                      className="object-cover w-full h-full"
                    />
                  </div>
                )}

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-charcoal-900 truncate">
                    {item.title}
                  </h4>
                  {item.variantTitle && (
                    <p className="text-xs text-smoke-400 mt-0.5">{item.variantTitle}</p>
                  )}
                  <p className="text-sm font-semibold text-charcoal-900 tabular-nums mt-1">
                    {lineTotal}
                  </p>

                  <div className="flex items-center justify-between mt-2">
                    <QuantitySelector
                      quantity={item.quantity}
                      onQuantityChange={(qty) => updateItem(item.id, { quantity: qty })}
                      min={1}
                      max={99}
                      size="sm"
                    />
                    <button
                      onClick={() => removeItem(item.id)}
                      className="p-1.5 text-smoke-400 hover:text-red-600 transition-colors duration-300"
                      aria-label={`Remover ${item.title}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Sheet>
  )
}
