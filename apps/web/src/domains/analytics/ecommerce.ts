/**
 * E-commerce–specific analytics helpers.
 *
 * Provides typed wrappers for common commerce funnels:
 * - Cart funnel (add → drawer → checkout)
 * - Purchase funnel (checkout_started → step_completed → completed)
 * - Revenue attribution
 *
 * These complement the generic track() function with structured payloads.
 */

import { track, getSessionId } from './track'

// ── Cart Funnel ──────────────────────────────────────────────────────────────

export function trackAddToCart(params: {
  productId: string
  variantId?: string
  quantity: number
  price: number
  source: 'pdp' | 'quick_view' | 'carousel' | 'cross_sell' | 'search'
}) {
  track('add_to_cart', params)
}

export function trackCrossSellViewed(params: {
  productId: string
  suggestedCategory: string
  suggestedProductIds: string[]
}) {
  track('cross_sell_viewed', params)
}

export function trackCrossSellAdded(params: {
  productId: string
  sourceProductId: string
  suggestedCategory: string
}) {
  track('cross_sell_added', params)
}

// ── Checkout Funnel ──────────────────────────────────────────────────────────

export function trackCheckoutStarted(params: {
  cartTotal: number
  itemCount: number
  cartType: 'food' | 'merchandise' | 'mixed'
}) {
  track('checkout_started', params)
}

export function trackCheckoutStepCompleted(params: {
  step: 'address' | 'shipping' | 'payment' | 'review'
  cartTotal: number
}) {
  track('checkout_step_completed', params)
}

export function trackCheckoutCompleted(params: {
  orderId: string
  total: number
  itemCount: number
  paymentMethod: string
}) {
  track('checkout_completed', {
    ...params,
    sessionId: getSessionId(),
  })
}

export function trackCheckoutError(params: {
  step: string
  error: string
}) {
  track('checkout_error', params)
}

export function trackCheckoutAbandoned(params: {
  step: string
  cartTotal: number
  itemCount: number
}) {
  track('checkout_abandoned', params)
}
