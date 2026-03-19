/**
 * PostHog Client Singleton
 *
 * Initializes PostHog with our custom config:
 * - autocapture: false (our event taxonomy is explicit)
 * - capture_pageview: false (we fire manually on Next.js route changes)
 * - person_profiles: 'identified_only' (no anonymous user bloat)
 *
 * Returns null if NEXT_PUBLIC_POSTHOG_KEY is not set (dev mode without PostHog).
 */

import posthog from 'posthog-js'
import type { PostHog } from 'posthog-js'

let posthogClient: PostHog | null = null
let initialized = false

export function getPostHogClient(): PostHog | null {
  if (globalThis.window === undefined) return null

  if (initialized) return posthogClient

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://app.posthog.com'

  if (!key) {
    initialized = true
    return null
  }

  posthog.init(key, {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    // Cookie persistence instead of localStorage to prevent XSS data exposure
    persistence: 'cookie',
    secure_cookie: true,
    cross_subdomain_cookie: false,
    person_profiles: 'identified_only',
  })

  posthogClient = posthog
  initialized = true

  return posthogClient
}

/**
 * Reset PostHog state (useful for testing).
 */
export function resetPostHogClient(): void {
  posthogClient = null
  initialized = false
}
