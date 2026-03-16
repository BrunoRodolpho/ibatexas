/**
 * IbateXas Feature Flag System
 *
 * Typed wrapper around PostHog feature flags for safe rollouts.
 *
 * @example
 *   if (flag('new_checkout')) {
 *     return <NewCheckout />
 *   }
 *
 * Without PostHog, all flags default to `false` (off).
 */

import { getPostHogClient } from '@/lib/posthog'

/**
 * Known feature flags — add new ones here for type safety.
 * Value is the default when PostHog is unavailable.
 */
export interface FlagMap {
  new_checkout: boolean
  promotions_banner: boolean
  region_pricing: boolean
  recommendation_engine: boolean
  reservation_v2: boolean
  loyalty_program: boolean
}

export type FlagName = keyof FlagMap

const DEFAULTS: FlagMap = {
  new_checkout: false,
  promotions_banner: false,
  region_pricing: false,
  recommendation_engine: false,
  reservation_v2: false,
  loyalty_program: false,
}

/**
 * Check if a feature flag is enabled.
 */
export function flag(name: FlagName): boolean {
  const posthog = getPostHogClient()
  if (!posthog) return DEFAULTS[name]

  const value = posthog.isFeatureEnabled(name)
  return value ?? DEFAULTS[name]
}

/**
 * Get the feature flag payload (JSON config from PostHog).
 */
export function flagPayload<T = unknown>(name: FlagName): T | null {
  const posthog = getPostHogClient()
  if (!posthog) return null

  const result = posthog.getFeatureFlagResult(name, { send_event: false })
  return (result?.payload as T) ?? null
}
