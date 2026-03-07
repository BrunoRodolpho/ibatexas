'use client'

import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { useTranslations } from 'next-intl'
import { ShoppingBag, Check, Clock, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { track } from '@/domains/analytics'
import { FREE_DELIVERY_THRESHOLD } from '@/lib/constants'

/**
 * Sticky bottom cart bar — visible when items are in the cart.
 * Replaces the invisible cart with an always-present summary.
 * Pattern: DoorDash / iFood sticky checkout bar.
 */
export function StickyCartBar() {
  const t = useTranslations()
  const items = useCartStore((s) => s.items)
  const getTotal = useCartStore((s) => s.getTotal)
  const getItemCount = useCartStore((s) => s.getItemCount)
  const openCartDrawer = useUIStore((s) => s.openCartDrawer)
  const estimatedMinutes = useCartStore((s) => s.estimatedDeliveryMinutes)

  const itemCount = getItemCount()
  const subtotal = getTotal()
  const subtotalFormatted = (subtotal / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  // Bounce animation when items are added
  const [isBouncing, setIsBouncing] = useState(false)
  const [isDismissed, setIsDismissed] = useState(false)
  const prevCountRef = useRef(itemCount)

  useEffect(() => {
    if (itemCount > prevCountRef.current) {
      setIsBouncing(true)
      setIsDismissed(false) // Auto-show when new item added
      const timer = setTimeout(() => setIsBouncing(false), 600)
      return () => clearTimeout(timer)
    }
    if (itemCount < prevCountRef.current && itemCount > 0) {
      setIsDismissed(false) // Also show when item removed (cart changed)
    }
    prevCountRef.current = itemCount
  }, [itemCount])

  if (itemCount === 0 || isDismissed) return null

  const handleClick = () => {
    track('cart_drawer_opened', { source: 'sticky_bar' })
    openCartDrawer()
  }

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsDismissed(true)
    track('sticky_cta_used', { action: 'dismissed' })
  }

  return (
    <div
      className={`fixed bottom-14 sm:bottom-4 left-0 sm:left-1/2 sm:-translate-x-1/2 right-0 sm:right-auto z-40 sm:max-w-md w-full px-0 sm:px-0 transition-all duration-500 ease-luxury ${
        isBouncing ? 'animate-bounce-y' : ''
      }`}
    >
      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        className="absolute -top-2 right-2 sm:right-0 z-50 w-6 h-6 rounded-full bg-charcoal-700 text-smoke-300 hover:text-smoke-50 flex items-center justify-center shadow-md transition-colors"
        aria-label={t('sticky_cart.dismiss')}
      >
        <X className="w-3.5 h-3.5" strokeWidth={2.5} />
      </button>

      <button
        onClick={handleClick}
        className="w-full bg-charcoal-900 text-smoke-50 sm:rounded-card shadow-xl hover:bg-charcoal-800 active:scale-[0.98] transition-all duration-300 ease-luxury overflow-hidden"
      >
        {/* Free delivery progress bar */}
        <div className="h-[3px] w-full bg-charcoal-700">
          <div
            className="h-full bg-brand-500 transition-all duration-700 ease-luxury"
            style={{ width: `${Math.min((subtotal / FREE_DELIVERY_THRESHOLD) * 100, 100)}%` }}
          />
        </div>

        <div className="flex items-center justify-between px-5 py-3.5 sm:py-3">
          <div className="flex items-center gap-3">
            <div className="relative">
              <ShoppingBag className="w-5 h-5" strokeWidth={1.5} />
              <span className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">
                {itemCount}
              </span>
            </div>
            <div className="flex flex-col items-start">
              <span className="text-sm font-medium">
                {itemCount} {itemCount === 1 ? 'item' : 'itens'}
              </span>
              {subtotal < FREE_DELIVERY_THRESHOLD ? (
                <span className="text-[10px] text-smoke-400">
                  {t('sticky_cart.free_delivery_progress', {
                    remaining: ((FREE_DELIVERY_THRESHOLD - subtotal) / 100).toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    }),
                  })}
                </span>
              ) : (
                <span className="text-[10px] text-brand-400 flex items-center gap-0.5">
                  <Check className="w-3 h-3" strokeWidth={2.5} />
                  {t('sticky_cart.free_delivery_reached')}
                </span>
              )}
              <span className="text-[10px] text-smoke-400 flex items-center gap-0.5">
                <Clock className="w-3 h-3" strokeWidth={1.5} />
                {estimatedMinutes
                  ? t('sticky_cart.estimated_delivery', { minutes: estimatedMinutes })
                  : t('sticky_cart.delivery_fallback')
                }
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-base font-semibold tabular-nums">
              {subtotalFormatted}
            </span>
            <span className="bg-smoke-50 text-charcoal-900 text-xs font-semibold px-3 py-1.5 rounded-sm">
              {t('sticky_cart.view')}
            </span>
          </div>
        </div>
      </button>
    </div>
  )
}
