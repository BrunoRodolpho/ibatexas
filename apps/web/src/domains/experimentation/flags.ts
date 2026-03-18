/**
 * IbateXas Feature Flag System
 *
 * Typed wrapper around PostHog feature flags for safe rollouts.
 *
 * @example
 *   if (flag('recommendation_engine')) {
 *     return <Recommendations />
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
  recommendation_engine: boolean
}

export type FlagName = keyof FlagMap

const DEFAULTS: FlagMap = {
  recommendation_engine: false,
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
