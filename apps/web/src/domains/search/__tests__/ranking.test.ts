import { describe, it, expect } from 'vitest'
import { getRankingConfig, type RankingConfig } from '../ranking'

describe('getRankingConfig', () => {
  // ── Default config ────────────────────────────────────────────────────

  it('returns defaults when called with no overrides', () => {
    const config = getRankingConfig()
    expect(config).toEqual({
      boostPopular: true,
      boostAvailable: true,
      penalizeSeasonal: false,
    })
  })

  it('returns defaults when called with undefined', () => {
    const config = getRankingConfig(undefined)
    expect(config).toEqual({
      boostPopular: true,
      boostAvailable: true,
      penalizeSeasonal: false,
    })
  })

  it('returns defaults when called with empty object', () => {
    const config = getRankingConfig({})
    expect(config).toEqual({
      boostPopular: true,
      boostAvailable: true,
      penalizeSeasonal: false,
    })
  })

  // ── Partial overrides ──────────────────────────────────────────────────

  it('overrides boostPopular while keeping other defaults', () => {
    const config = getRankingConfig({ boostPopular: false })
    expect(config.boostPopular).toBe(false)
    expect(config.boostAvailable).toBe(true)
    expect(config.penalizeSeasonal).toBe(false)
  })

  it('overrides penalizeSeasonal while keeping other defaults', () => {
    const config = getRankingConfig({ penalizeSeasonal: true })
    expect(config.penalizeSeasonal).toBe(true)
    expect(config.boostPopular).toBe(true)
    expect(config.boostAvailable).toBe(true)
  })

  it('overrides boostAvailable while keeping other defaults', () => {
    const config = getRankingConfig({ boostAvailable: false })
    expect(config.boostAvailable).toBe(false)
    expect(config.boostPopular).toBe(true)
    expect(config.penalizeSeasonal).toBe(false)
  })

  // ── Full overrides ─────────────────────────────────────────────────────

  it('overrides all fields at once', () => {
    const custom: RankingConfig = {
      boostPopular: false,
      boostAvailable: false,
      penalizeSeasonal: true,
    }
    const config = getRankingConfig(custom)
    expect(config).toEqual(custom)
  })

  // ── Immutability ──────────────────────────────────────────────────────

  it('returns a new object on each call (no shared references)', () => {
    const a = getRankingConfig()
    const b = getRankingConfig()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('does not mutate the input overrides object', () => {
    const overrides = { boostPopular: false }
    const config = getRankingConfig(overrides)
    expect(config.boostAvailable).toBe(true)
    // overrides should not have been mutated
    expect(overrides).toEqual({ boostPopular: false })
  })
})
