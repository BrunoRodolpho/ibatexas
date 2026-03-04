/**
 * IbateXas Analytics Layer
 *
 * Lightweight event tracking with dual-channel delivery:
 * - PostHog (client-side) for dashboards, funnels, session replay
 * - sendBeacon → /api/analytics/track → NATS for domain event bus
 *
 * North Star Metric: Revenue Per Session (RPS) = totalRevenue / totalSessions
 */

import { getPostHogClient } from './posthog'

export type AnalyticsEvent =
  | 'quick_add_clicked'
  | 'add_to_cart'
  | 'sticky_cta_used'
  | 'pdp_viewed'
  | 'product_card_clicked'
  | 'cross_sell_viewed'
  | 'cross_sell_added'
  | 'cart_drawer_opened'
  | 'checkout_started'
  | 'checkout_step_completed'
  | 'checkout_error'
  | 'checkout_abandoned'
  | 'checkout_completed'
  | 'session_started'
  | 'pdp_scroll_depth'
  | 'review_link_clicked'
  | 'storytelling_section_viewed'
  | 'filter_applied'
  | 'search_performed'

const isDev = process.env.NODE_ENV === 'development'

let sessionId: string | null = null

// ── Meaningful events that trigger session_started ────────────────────────
// Bounced visitors don't count in RPS denominator.
// checkout_started covers returning users who land on checkout with a persisted cart.
const MEANINGFUL_EVENTS: AnalyticsEvent[] = [
  'pdp_viewed',
  'search_performed',
  'add_to_cart',
  'checkout_started',
]

/**
 * Fire session_started lazily on first meaningful interaction.
 * Uses sessionStorage flag to ensure once-per-session firing.
 */
function ensureSessionStarted(event: AnalyticsEvent): void {
  if (!MEANINGFUL_EVENTS.includes(event)) return
  if (typeof window === 'undefined') return
  if (sessionStorage.getItem('ibx_session_started')) return
  sessionStorage.setItem('ibx_session_started', '1')
  // Fire session_started — recursive call is safe because flag is now set
  track('session_started', {})
}

export function getSessionId(): string {
  if (sessionId) return sessionId

  if (typeof window === 'undefined') return 'ssr'

  // Try to reuse existing session from sessionStorage
  const stored = sessionStorage.getItem('ibx_analytics_session')
  if (stored) {
    sessionId = stored
    // Register ibx_session_id as PostHog super property for correlation
    const posthog = getPostHogClient()
    if (posthog) {
      posthog.register({ ibx_session_id: sessionId })
    }
    return sessionId
  }

  // Create new session
  sessionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`

  sessionStorage.setItem('ibx_analytics_session', sessionId)

  // Register ibx_session_id as PostHog super property for correlation
  const posthog = getPostHogClient()
  if (posthog) {
    posthog.register({ ibx_session_id: sessionId })
  }

  return sessionId
}

function trackRaw(event: string, properties?: Record<string, unknown>): void {
  const enrichedProperties = {
    ...properties,
    sessionId: sessionId ?? 'unknown',
    ibx_session_id: sessionId ?? 'unknown',
    timestamp: new Date().toISOString(),
    url: typeof window !== 'undefined' ? window.location.pathname : undefined,
  }

  const payload = {
    event,
    properties: enrichedProperties,
  }

  if (isDev) {
    console.log('[analytics]', event, payload.properties)
  }

  // PostHog: client-side capture for dashboards/funnels
  const posthog = getPostHogClient()
  if (posthog) {
    posthog.capture(event, { ...enrichedProperties })
  }

  // In dev, skip sendBeacon (PostHog + console.log are sufficient)
  if (isDev) return

  // Fire-and-forget POST to analytics endpoint → NATS
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
    navigator.sendBeacon?.(
      `${apiBase}/api/analytics/track`,
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    ) ??
      fetch(`${apiBase}/api/analytics/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {
        // Silent fail — analytics should never block UX
      })
  } catch {
    // Silent fail
  }
}

/**
 * Track an analytics event.
 *
 * @example
 *   track('add_to_cart', { productId: 'abc', quantity: 2, source: 'pdp' })
 */
export function track(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return

  // Ensure session is initialised
  getSessionId()

  // Fire session_started lazily on first meaningful interaction
  ensureSessionStarted(event)

  trackRaw(event, properties)
}

/**
 * Track PDP scroll depth via scroll position percentage.
 * Fires at 25/50/75/100% of full page height.
 * Short page guard: fires 100% immediately if content fits in viewport.
 *
 * @returns Cleanup function for useEffect
 */
export function trackScrollDepth(productId: string): () => void {
  // Short page guard: if content fits in viewport, fire 100% immediately
  if (document.body.scrollHeight <= window.innerHeight) {
    track('pdp_scroll_depth', { productId, depth: 100 })
    return () => {}
  }

  const thresholds = [25, 50, 75, 100]
  const fired = new Set<number>()

  const handleScroll = () => {
    const scrollPercent = Math.round(
      ((window.scrollY + window.innerHeight) / document.body.scrollHeight) * 100,
    )
    for (const t of thresholds) {
      if (scrollPercent >= t && !fired.has(t)) {
        fired.add(t)
        track('pdp_scroll_depth', { productId, depth: t })
      }
    }
  }

  window.addEventListener('scroll', handleScroll, { passive: true })
  return () => window.removeEventListener('scroll', handleScroll)
}

/**
 * Hook-friendly: observe an element and fire an event once visible.
 */
export function trackOnceVisible(
  element: HTMLElement,
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
): () => void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          track(event, properties)
          observer.disconnect()
        }
      }
    },
    { threshold: 0.3 },
  )

  observer.observe(element)
  return () => observer.disconnect()
}
