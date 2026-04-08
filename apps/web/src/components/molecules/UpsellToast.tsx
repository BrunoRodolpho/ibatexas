'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import NextImage from 'next/image'
import { Plus, X } from 'lucide-react'
import { useUIStore } from '@/domains/ui'
import { useCartStore } from '@/domains/cart/cart.store'
import { getCrossSellCategory } from '@/domains/product/cross-sell'
import { track } from '@/domains/analytics'
import { apiFetch } from '@/lib/api'
import { BLUR_PLACEHOLDER } from '@/lib/constants'
import { formatBRL } from '@/lib/format'
import type { ProductDTO } from '@ibatexas/types'

// Was 6000 — too fast for users to read + react. Bumped to 9s and the bar
// pauses on hover so the user controls dismissal.
const AUTO_DISMISS_MS = 9000

/**
 * Post-add-to-cart upsell toast.
 * Fetches a complementary product based on the CROSS_SELL_MAP
 * and shows a compact suggestion above the StickyCartBar.
 */
export function UpsellToast() {
  const t = useTranslations()
  const triggerCategory = useUIStore((s) => s.upsellTriggerCategory)
  const upsellProduct = useUIStore((s) => s.upsellProduct)
  const setUpsellProduct = useUIStore((s) => s.setUpsellProduct)
  const dismissUpsell = useUIStore((s) => s.dismissUpsell)
  const addItem = useCartStore((s) => s.addItem)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isPaused, setIsPaused] = useState(false)

  // Fetch a cross-sell product when trigger fires
  useEffect(() => {
    if (!triggerCategory) return

    const crossCategory = getCrossSellCategory(triggerCategory)
    if (!crossCategory) {
      dismissUpsell()
      return
    }

    const controller = new AbortController()
    apiFetch<{ items?: ProductDTO[]; products?: ProductDTO[] }>(
      `/api/products?categoryHandle=${crossCategory}&limit=1`,
      { signal: controller.signal },
    )
      .then((res) => {
        const items = res.items ?? res.products ?? []
        if (items.length > 0) {
          const p = items[0]
          setUpsellProduct({
            productId: p.id,
            title: p.title,
            price: p.price,
            imageUrl: p.imageUrl || p.images?.[0],
          })
          track('upsell_toast_shown', { productId: p.id, crossCategory })
        } else {
          dismissUpsell()
        }
      })
      .catch(() => dismissUpsell())

    return () => controller.abort()
  }, [triggerCategory, setUpsellProduct, dismissUpsell])

  // Auto-dismiss timer — pauses while hovered so the user has time to read.
  // Resets the full duration when re-entering rather than tracking remaining time;
  // simpler and the UX cost (an extra few seconds on hover-out) is fine here.
  useEffect(() => {
    if (!upsellProduct || isPaused) return
    timerRef.current = setTimeout(() => {
      track('upsell_toast_dismissed', { productId: upsellProduct.productId, auto: true })
      dismissUpsell()
    }, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [upsellProduct, dismissUpsell, isPaused])

  if (!upsellProduct) return null

  const priceFormatted = formatBRL(upsellProduct.price)

  const handleAdd = () => {
    addItem(
      { id: upsellProduct.productId, title: upsellProduct.title, price: upsellProduct.price, imageUrl: upsellProduct.imageUrl } as ProductDTO,
      1,
    )
    track('upsell_toast_added', { productId: upsellProduct.productId })
    dismissUpsell()
  }

  const handleDismiss = () => {
    track('upsell_toast_dismissed', { productId: upsellProduct.productId, auto: false })
    dismissUpsell()
  }

  return (
    <div
      className="fixed bottom-[7.5rem] sm:bottom-20 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-sm z-50 animate-fade-up"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      role="region"
      aria-label={t('upsell.also_add')}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="surface-card rounded-card overflow-hidden shadow-lg">
        <div className="p-2.5 flex items-center gap-2.5">
          {/* Product thumbnail */}
          {upsellProduct.imageUrl && (
            <div className="relative w-9 h-9 rounded-sm overflow-hidden flex-shrink-0 bg-smoke-100">
              <NextImage
                src={upsellProduct.imageUrl}
                alt={upsellProduct.title}
                fill
                sizes="36px"
                placeholder="blur"
                blurDataURL={BLUR_PLACEHOLDER}
                className="object-cover"
              />
            </div>
          )}

          {/* Product info */}
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-[var(--color-text-secondary)] font-medium">{t('upsell.also_add')}</p>
            <p className="text-sm font-semibold text-charcoal-900 truncate">{upsellProduct.title}</p>
            <p className="text-xs tabular-nums text-smoke-500">{priceFormatted}</p>
          </div>

          {/* Add button */}
          <button
            onClick={handleAdd}
            className="flex-shrink-0 bg-brand-500 text-white h-7 px-2.5 rounded-sm flex items-center gap-1 text-xs font-medium hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2} />
            {t('upsell.add')}
          </button>

          {/* Dismiss */}
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 text-[var(--color-text-secondary)] hover:text-charcoal-900 transition-colors"
            aria-label={t('upsell.dismiss_suggestion')}
          >
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>

        {/*
          Auto-dismiss progress bar. Animation duration matches AUTO_DISMISS_MS;
          `animation-play-state` follows the hover-pause flag so the bar visibly
          freezes when the user hovers, restoring perceived control.
          Keyed on productId so the animation restarts on each new upsell.
        */}
        <div className="h-[2px] w-full bg-smoke-200 overflow-hidden">
          <div
            key={upsellProduct.productId}
            className="h-full bg-brand-500"
            style={{
              animation: `upsell-progress ${AUTO_DISMISS_MS}ms linear forwards`,
              animationPlayState: isPaused ? 'paused' : 'running',
            }}
          />
        </div>
      </div>
    </div>
  )
}
