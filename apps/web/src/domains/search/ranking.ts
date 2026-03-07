/**
 * Search ranking configuration.
 *
 * Controls how Typesense results are boosted / penalized.
 * Extend this as search quality requirements grow.
 *
 * @example
 *   const boosted = applyBoosts(rawResults, { boostPopular: true })
 */

export interface RankingConfig {
  /** Boost products with the 'popular' tag */
  boostPopular?: boolean
  /** Boost products currently in stock */
  boostAvailable?: boolean
  /** Penalize out-of-season items */
  penalizeSeasonal?: boolean
}

const DEFAULT_CONFIG: RankingConfig = {
  boostPopular: true,
  boostAvailable: true,
  penalizeSeasonal: false,
}

/**
 * Merge user config with defaults.
 * Actual ranking logic will be implemented when Typesense
 * custom scoring or re-ranking is needed.
 */
export function getRankingConfig(overrides?: Partial<RankingConfig>): RankingConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}
