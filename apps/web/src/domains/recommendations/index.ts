/**
 * Recommendations Domain
 *
 * Personalized product recommendations powered by the intelligence
 * backend (co-purchase data, customer profiles, bestsellers).
 *
 * Gated behind the `recommendation_engine` feature flag.
 * When disabled, hooks return empty arrays — consumers should
 * fall back to static cross-sell from `@/domains/product`.
 *
 * @example
 *   import { useAlsoAdded, useRecommendations } from '@/domains/recommendations'
 */

export { useAlsoAdded, useRecommendations } from './recommendations.hooks'
export type {
  RecommendedProduct,
  RecommendationsResponse,
  AlsoAddedResponse,
} from './recommendations.types'
