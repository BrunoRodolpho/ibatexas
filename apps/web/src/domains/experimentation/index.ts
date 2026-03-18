/**
 * Experimentation Domain
 *
 * Centralises A/B testing and feature flag logic.
 * Both powered by PostHog under the hood.
 *
 * @example
 *   import { experiment, flag } from '@/domains/experimentation'
 *
 *   if (flag('recommendation_engine')) { ... }
 *   const variant = experiment('hero_layout')
 */

export { experiment, experimentPayload } from './experiments'
export type { ExperimentMap, ExperimentName } from './experiments'

export { flag, flagPayload } from './flags'
export type { FlagMap, FlagName } from './flags'
