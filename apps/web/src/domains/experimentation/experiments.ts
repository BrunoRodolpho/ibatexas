/**
 * IbateXas Experimentation Layer
 *
 * Lightweight A/B testing powered by PostHog feature flags.
 * Provides a typed API for experiment variants.
 *
 * @example
 *   const variant = experiment('hero_layout')
 *   if (variant === 'A') { ... }
 *
 * PostHog must be initialised (NEXT_PUBLIC_POSTHOG_KEY set) for
 * experiments to work. Without it, the control variant is always returned.
 */

import { getPostHogClient } from '@/lib/posthog'

/**
 * Known experiments — add new ones here so they're type-safe.
 * Key = experiment name in PostHog, Value = possible variant strings.
 */
export interface ExperimentMap {
  hero_layout: 'control' | 'A' | 'B'
  pdp_sticky_cta: 'control' | 'sticky_bar' | 'floating_button'
  checkout_flow: 'control' | 'single_page'
  search_ranking: 'control' | 'popularity_boost'
}

export type ExperimentName = keyof ExperimentMap

/**
 * Get the current variant for an experiment.
 * Returns 'control' if PostHog is not available or the experiment isn't running.
 */
export function experiment<K extends ExperimentName>(
  name: K,
): ExperimentMap[K] {
  const posthog = getPostHogClient()
  if (!posthog) return 'control' as ExperimentMap[K]

  const variant = posthog.getFeatureFlag(name)
  if (typeof variant === 'string') return variant as ExperimentMap[K]

  return 'control' as ExperimentMap[K]
}

/**
 * Get experiment payload data (JSON config from PostHog).
 */
export function experimentPayload<T = unknown>(name: ExperimentName): T | null {
  const posthog = getPostHogClient()
  if (!posthog) return null

  const payload = posthog.getFeatureFlagPayload(name)
  return (payload as T) ?? null
}
