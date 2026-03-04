'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useCartStore } from '@/stores/useCartStore'
import { useUIStore } from '@/stores/useUIStore'
import { track } from '@/lib/analytics'

const ABANDONMENT_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes
const NUDGE_SESSION_KEY = 'cart_nudge_shown'

/**
 * Shows a toast nudge on mount when the cart has items that haven't been
 * modified in over 30 minutes: "Seus itens ainda estão no carrinho!"
 *
 * Only fires once per session (tracked via sessionStorage).
 */
export function useCartAbandonmentNudge() {
  const t = useTranslations('toast')
  const { addToast } = useUIStore()
  const firedRef = useRef(false)

  useEffect(() => {
    // Only fire once per component lifecycle + once per session
    if (firedRef.current) return
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem(NUDGE_SESSION_KEY)) return

    const state = useCartStore.getState()
    const { items, lastModifiedAt } = state

    if (items.length === 0 || !lastModifiedAt) return

    const elapsed = Date.now() - lastModifiedAt
    if (elapsed < ABANDONMENT_THRESHOLD_MS) return

    firedRef.current = true
    sessionStorage.setItem(NUDGE_SESSION_KEY, '1')

    addToast(t('cart_abandonment'), 'info')
    track('cart_abandonment_nudge', { itemCount: items.length, elapsedMs: elapsed })
  }, [addToast, t])
}
