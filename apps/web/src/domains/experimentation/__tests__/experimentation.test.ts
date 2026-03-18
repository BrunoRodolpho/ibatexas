/**
 * Tests for the experimentation domain — experiments and feature flags.
 * PostHog is mocked; we test the fallback / typed-wrapper logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock ────────────────────────────────────────────────────────────

const mockGetPostHogClient = vi.hoisted(() => vi.fn())

vi.mock('@/lib/posthog', () => ({
  getPostHogClient: mockGetPostHogClient,
}))

// ── Dynamic imports (reset per test for fresh module state) ─────────────────

let experiment: typeof import('../experiments').experiment
let experimentPayload: typeof import('../experiments').experimentPayload
let flag: typeof import('../flags').flag
let flagPayload: typeof import('../flags').flagPayload

describe('Experimentation Domain', () => {
  beforeEach(async () => {
    vi.resetModules()
    mockGetPostHogClient.mockReturnValue(null)

    const expMod = await import('../experiments')
    experiment = expMod.experiment
    experimentPayload = expMod.experimentPayload

    const flagMod = await import('../flags')
    flag = flagMod.flag
    flagPayload = flagMod.flagPayload
  })

  // ── experiment() ──────────────────────────────────────────────────────────

  describe('experiment()', () => {
    it('returns "control" when PostHog is unavailable', () => {
      mockGetPostHogClient.mockReturnValue(null)
      expect(experiment('hero_layout')).toBe('control')
    })

    it('returns the variant from PostHog when available', () => {
      mockGetPostHogClient.mockReturnValue({
        getFeatureFlag: (name: string) => (name === 'hero_layout' ? 'A' : undefined),
      })
      expect(experiment('hero_layout')).toBe('A')
    })

    it('falls back to "control" when PostHog returns undefined', () => {
      mockGetPostHogClient.mockReturnValue({
        getFeatureFlag: () => undefined,
      })
      expect(experiment('checkout_flow')).toBe('control')
    })

    it('falls back to "control" when PostHog returns a non-string', () => {
      mockGetPostHogClient.mockReturnValue({
        getFeatureFlag: () => true,
      })
      expect(experiment('search_ranking')).toBe('control')
    })
  })

  // ── experimentPayload() ───────────────────────────────────────────────────

  describe('experimentPayload()', () => {
    it('returns null when PostHog is unavailable', () => {
      mockGetPostHogClient.mockReturnValue(null)
      expect(experimentPayload('hero_layout')).toBeNull()
    })

    it('returns the payload from PostHog', () => {
      const payload = { showBadge: true, color: 'red' }
      mockGetPostHogClient.mockReturnValue({
        getFeatureFlagResult: () => ({ payload }),
      })
      expect(experimentPayload('hero_layout')).toEqual(payload)
    })

    it('returns null when PostHog returns undefined payload', () => {
      mockGetPostHogClient.mockReturnValue({
        getFeatureFlagResult: () => undefined,
      })
      expect(experimentPayload('hero_layout')).toBeNull()
    })
  })

  // ── flag() ────────────────────────────────────────────────────────────────

  describe('flag()', () => {
    it('returns false (default) when PostHog is unavailable', () => {
      mockGetPostHogClient.mockReturnValue(null)
      expect(flag('recommendation_engine')).toBe(false)
    })

    it('returns true when PostHog indicates the flag is enabled', () => {
      mockGetPostHogClient.mockReturnValue({
        isFeatureEnabled: () => true,
      })
      expect(flag('recommendation_engine')).toBe(true)
    })

    it('returns default when PostHog returns undefined', () => {
      mockGetPostHogClient.mockReturnValue({
        isFeatureEnabled: () => undefined,
      })
      expect(flag('recommendation_engine')).toBe(false)
    })
  })

  // ── flagPayload() ────────────────────────────────────────────────────────

  describe('flagPayload()', () => {
    it('returns null when PostHog is unavailable', () => {
      mockGetPostHogClient.mockReturnValue(null)
      expect(flagPayload('recommendation_engine')).toBeNull()
    })

    it('returns the payload from PostHog', () => {
      const testPayload = { maxDiscount: 20 }
      mockGetPostHogClient.mockReturnValue({
        getFeatureFlagResult: () => ({ payload: testPayload }),
      })
      expect(flagPayload('recommendation_engine')).toEqual(testPayload)
    })
  })
})
