// Tests for lib/profiles.ts — behavior profiles and scale presets.
// Pure data validation; no mocks needed.

import { describe, it, expect } from "vitest"

import {
  PROFILES,
  PROFILE_NAMES,
  SCALE_PRESETS,
  SCALE_NAMES,
  type BehaviorProfile,
  type ScalePreset,
} from "../lib/profiles.js"

// ── Profile structure tests ──────────────────────────────────────────────────

describe("PROFILES", () => {
  it("has at least 3 profiles", () => {
    expect(Object.keys(PROFILES).length).toBeGreaterThanOrEqual(3)
  })

  it("PROFILE_NAMES matches Object.keys(PROFILES)", () => {
    expect(PROFILE_NAMES).toEqual(Object.keys(PROFILES))
  })

  for (const [key, profile] of Object.entries(PROFILES)) {
    describe(`profile: ${key}`, () => {
      it("has a non-empty name", () => {
        expect(profile.name.length).toBeGreaterThan(0)
      })

      it("has a non-empty description", () => {
        expect(profile.description.length).toBeGreaterThan(0)
      })

      it("has at least one preferred category", () => {
        expect(profile.preferredCategories.length).toBeGreaterThan(0)
      })

      it("has at least one preferred product", () => {
        expect(profile.preferredProducts.length).toBeGreaterThan(0)
      })

      it("avgItemsPerOrder is a positive integer", () => {
        expect(profile.avgItemsPerOrder).toBeGreaterThan(0)
        expect(Number.isInteger(profile.avgItemsPerOrder)).toBe(true)
      })

      it("avgOrderValue is a positive integer in centavos", () => {
        expect(profile.avgOrderValue).toBeGreaterThan(0)
        expect(Number.isInteger(profile.avgOrderValue)).toBe(true)
      })

      it("frequencyDays is a positive number", () => {
        expect(profile.frequencyDays).toBeGreaterThan(0)
      })

      it("reviewProbability is between 0 and 1", () => {
        expect(profile.reviewProbability).toBeGreaterThanOrEqual(0)
        expect(profile.reviewProbability).toBeLessThanOrEqual(1)
      })

      it("ratingAvg is between 1 and 5", () => {
        expect(profile.ratingAvg).toBeGreaterThanOrEqual(1)
        expect(profile.ratingAvg).toBeLessThanOrEqual(5)
      })

      it("preferred product handles are kebab-case ASCII", () => {
        const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/
        for (const handle of profile.preferredProducts) {
          expect(kebab.test(handle), `"${handle}" is not kebab-case`).toBe(true)
        }
      })

      it("preferred category handles are kebab-case ASCII", () => {
        const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/
        for (const handle of profile.preferredCategories) {
          expect(kebab.test(handle), `"${handle}" is not kebab-case`).toBe(true)
        }
      })
    })
  }

  it("no duplicate preferred products within a profile", () => {
    for (const [key, profile] of Object.entries(PROFILES)) {
      const unique = new Set(profile.preferredProducts)
      expect(
        unique.size,
        `Profile "${key}" has duplicate preferred products`,
      ).toBe(profile.preferredProducts.length)
    }
  })

  it("no duplicate preferred categories within a profile", () => {
    for (const [key, profile] of Object.entries(PROFILES)) {
      const unique = new Set(profile.preferredCategories)
      expect(
        unique.size,
        `Profile "${key}" has duplicate preferred categories`,
      ).toBe(profile.preferredCategories.length)
    }
  })
})

// ── Scale presets ────────────────────────────────────────────────────────────

describe("SCALE_PRESETS", () => {
  it("has at least small, medium, large", () => {
    expect(SCALE_PRESETS.small).toBeDefined()
    expect(SCALE_PRESETS.medium).toBeDefined()
    expect(SCALE_PRESETS.large).toBeDefined()
  })

  it("SCALE_NAMES matches Object.keys(SCALE_PRESETS)", () => {
    expect(SCALE_NAMES).toEqual(Object.keys(SCALE_PRESETS))
  })

  for (const [key, preset] of Object.entries(SCALE_PRESETS)) {
    describe(`preset: ${key}`, () => {
      it("has a non-empty name", () => {
        expect(preset.name.length).toBeGreaterThan(0)
      })

      it("customers is a positive integer", () => {
        expect(preset.customers).toBeGreaterThan(0)
        expect(Number.isInteger(preset.customers)).toBe(true)
      })

      it("ordersPerDay is a positive integer", () => {
        expect(preset.ordersPerDay).toBeGreaterThan(0)
        expect(Number.isInteger(preset.ordersPerDay)).toBe(true)
      })

      it("days is a positive integer", () => {
        expect(preset.days).toBeGreaterThan(0)
        expect(Number.isInteger(preset.days)).toBe(true)
      })
    })
  }

  it("presets scale up: small < medium < large customers", () => {
    expect(SCALE_PRESETS.small.customers).toBeLessThan(SCALE_PRESETS.medium.customers)
    expect(SCALE_PRESETS.medium.customers).toBeLessThan(SCALE_PRESETS.large.customers)
  })

  it("presets scale up: small < medium < large ordersPerDay", () => {
    expect(SCALE_PRESETS.small.ordersPerDay).toBeLessThan(SCALE_PRESETS.medium.ordersPerDay)
    expect(SCALE_PRESETS.medium.ordersPerDay).toBeLessThan(SCALE_PRESETS.large.ordersPerDay)
  })
})
