/**
 * IbateXas Analytics — Core Tracking
 *
 * Lightweight event tracking with dual-channel delivery:
 * - PostHog (client-side) for dashboards, funnels, session replay
 * - sendBeacon → /api/analytics/track → NATS for domain event bus
 *
 * North Star Metric: Revenue Per Session (RPS) = totalRevenue / totalSessions
 */

import { getPostHogClient } from '@/lib/posthog'
import { useConsentStore } from '@/domains/consent'
import type { AnalyticsEvent } from './events'

const isDev = process.env.NODE_ENV === 'development'

// Dual session IDs by design:
// 1. Analytics sessionId (sessionStorage, per-tab): ephemeral, for RPS metric denominator.
// 2. Zustand sessionId (localStorage, persistent): for API calls and cart association.
let sessionId: string | null = null

// ── Meaningful events that trigger session_started ────────────────────────
// Bounced visitors don't count in RPS denominator.
// checkout_started covers returning users who land on checkout with a persisted cart.
const MEANINGFUL_EVENTS = new Set<AnalyticsEvent>([
  'pdp_viewed',
  'search_performed',
  'add_to_cart',
  'checkout_started',
])

/**
 * Fire session_started lazily on first meaningful interaction.
 * Uses sessionStorage flag to ensure once-per-session firing.
 */
function ensureSessionStarted(event: AnalyticsEvent): void {
  if (!MEANINGFUL_EVENTS.has(event)) return
  if (globalThis.window === undefined) return
  if (sessionStorage.getItem('ibx_session_started')) return
  sessionStorage.setItem('ibx_session_started', '1')
  // Fire session_started — recursive call is safe because flag is now set
  track('session_started', {})
}

/** Register sessionId as a PostHog super property for cross-tool correlation. */
function registerPostHogSession(id: string): void {
  const posthog = getPostHogClient()
  if (posthog) posthog.register({ ibx_session_id: id })
}

export function getSessionId(): string {
  if (sessionId) return sessionId
  if (globalThis.window === undefined) return 'ssr'

  // Try to reuse existing session from sessionStorage
  const stored = sessionStorage.getItem('ibx_analytics_session')
  if (stored) {
    sessionId = stored
    registerPostHogSession(sessionId)
    return sessionId
  }

  // Create new session
  sessionId = crypto.randomUUID()

  sessionStorage.setItem('ibx_analytics_session', sessionId)
  registerPostHogSession(sessionId)

  return sessionId
}

const PII_KEYS = ['email', 'phone', 'cpf', 'nome', 'telefone', 'endereco'];

/** Enrich raw event properties with session/timestamp context. */
function enrichProperties(properties?: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...properties,
    sessionId: sessionId ?? 'unknown',
    ibx_session_id: sessionId ?? 'unknown',
    timestamp: new Date().toISOString(),
    url: globalThis.window === undefined ? undefined : (globalThis.window as Window)?.location?.pathname,
  }

  for (const key of PII_KEYS) {
    delete merged[key];
  }

  return merged;
}

/** Fire-and-forget beacon/fetch to the analytics API. */
function sendToApi(payload: { event: string; properties: Record<string, unknown> }): void {
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
    const url = `${apiBase}/api/analytics/track`
    const body = JSON.stringify(payload)

    const sent = navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))
    if (!sent) {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => { /* analytics should never block UX */ })
    }
  } catch {
    // Silent fail
  }
}

function trackRaw(event: string, properties?: Record<string, unknown>): void {
  const enriched = enrichProperties(properties)
  const payload = { event, properties: enriched }

  if (isDev) console.log('[analytics]', event, enriched)

  const posthog = getPostHogClient()
  if (posthog) posthog.capture(event, { ...enriched })

  if (!isDev) sendToApi(payload)
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
  if (globalThis.window === undefined) return

  // No-op when consent not accepted
  if (!useConsentStore.getState().accepted) return

  // Ensure session is initialised
  getSessionId()

  // Capture UTM params once per session on first track() call
  captureUtmParams()

  // Fire session_started lazily on first meaningful interaction
  ensureSessionStarted(event)

  // Enrich checkout_completed with stored UTM params for attribution
  if (event === 'checkout_completed') {
    const utmParams = getStoredUtmParams()
    trackRaw(event, { ...properties, ...(utmParams ?? {}) })
    return
  }

  trackRaw(event, properties)
}

/**
 * Capture UTM parameters from the current URL and store in sessionStorage.
 * Fires utm_source_captured event if any UTM params are present.
 * Called once per session on first meaningful interaction.
 */
export function captureUtmParams(): void {
  if (globalThis.window === undefined) return
  if (!useConsentStore.getState().accepted) return
  if (sessionStorage.getItem('ibx_utm_captured')) return

  const params = new URLSearchParams(globalThis.window.location.search)
  const utmSource = params.get('utm_source')
  const utmMedium = params.get('utm_medium')
  const utmCampaign = params.get('utm_campaign')

  if (!utmSource && !utmMedium && !utmCampaign) return

  const utmData: Record<string, string> = {}
  if (utmSource) utmData.utm_source = utmSource
  if (utmMedium) utmData.utm_medium = utmMedium
  if (utmCampaign) utmData.utm_campaign = utmCampaign

  sessionStorage.setItem('ibx_utm', JSON.stringify(utmData))
  sessionStorage.setItem('ibx_utm_captured', '1')

  trackRaw('utm_source_captured', utmData)
}

/**
 * Read stored UTM params from sessionStorage.
 * Returns null if no UTM params were captured this session.
 */
function getStoredUtmParams(): Record<string, string> | null {
  if (globalThis.window === undefined) return null
  const raw = sessionStorage.getItem('ibx_utm')
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return null
  }
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
  if (document.body.scrollHeight <= globalThis.innerHeight) {
    track('pdp_scroll_depth', { productId, depth: 100 })
    return () => {}
  }

  const thresholds = [25, 50, 75, 100]
  const fired = new Set<number>()

  const handleScroll = () => {
    const scrollPercent = Math.round(
      ((globalThis.scrollY + globalThis.innerHeight) / document.body.scrollHeight) * 100,
    )
    for (const t of thresholds) {
      if (scrollPercent < t || fired.has(t)) continue
      fired.add(t)
      track('pdp_scroll_depth', { productId, depth: t })
    }
  }

  globalThis.addEventListener('scroll', handleScroll, { passive: true })
  return () => globalThis.removeEventListener('scroll', handleScroll)
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
