import { describe, it, expect } from "vitest"
import {
  MAX_PARTY_SIZE,
  SLOT_DURATION_MINUTES,
  SEED_DAYS_AHEAD,
  LUNCH_STARTS,
  DINNER_STARTS,
  SHIPPING_RATES,
  SHIPPING_RATE_DEFAULT,
} from "../constants.js"

describe("Business Constants", () => {
  it("MAX_PARTY_SIZE is a positive integer", () => {
    expect(MAX_PARTY_SIZE).toBeGreaterThan(0)
    expect(Number.isInteger(MAX_PARTY_SIZE)).toBe(true)
  })

  it("SLOT_DURATION_MINUTES is at least 30", () => {
    expect(SLOT_DURATION_MINUTES).toBeGreaterThanOrEqual(30)
  })

  it("SEED_DAYS_AHEAD is at least 7", () => {
    expect(SEED_DAYS_AHEAD).toBeGreaterThanOrEqual(7)
  })

  it("has lunch and dinner start times", () => {
    expect(LUNCH_STARTS.length).toBeGreaterThan(0)
    expect(DINNER_STARTS.length).toBeGreaterThan(0)
    for (const t of [...LUNCH_STARTS, ...DINNER_STARTS]) {
      expect(t).toMatch(/^\d{2}:\d{2}$/)
    }
  })

  describe("Shipping Rates", () => {
    it("covers all CEP first digits 1..9", () => {
      for (let d = 1; d <= 9; d++) {
        expect(SHIPPING_RATES[d]).toBeDefined()
        expect(SHIPPING_RATES[d].pac.price).toBeGreaterThan(0)
        expect(SHIPPING_RATES[d].sedex.price).toBeGreaterThan(0)
        expect(SHIPPING_RATES[d].pac.days).toBeGreaterThan(0)
        expect(SHIPPING_RATES[d].sedex.days).toBeGreaterThan(0)
      }
    })

    it("default fallback has valid rates", () => {
      expect(SHIPPING_RATE_DEFAULT.pac.price).toBeGreaterThan(0)
      expect(SHIPPING_RATE_DEFAULT.sedex.price).toBeGreaterThan(0)
    })

    it("SEDEX is always more expensive than PAC", () => {
      for (const [, rate] of Object.entries(SHIPPING_RATES)) {
        expect(rate.sedex.price).toBeGreaterThan(rate.pac.price)
      }
      expect(SHIPPING_RATE_DEFAULT.sedex.price).toBeGreaterThan(SHIPPING_RATE_DEFAULT.pac.price)
    })

    it("SEDEX is always faster than PAC", () => {
      for (const [, rate] of Object.entries(SHIPPING_RATES)) {
        expect(rate.sedex.days).toBeLessThan(rate.pac.days)
      }
    })

    it("prices are in centavos (integers)", () => {
      for (const [, rate] of Object.entries(SHIPPING_RATES)) {
        expect(Number.isInteger(rate.pac.price)).toBe(true)
        expect(Number.isInteger(rate.sedex.price)).toBe(true)
      }
    })
  })
})
