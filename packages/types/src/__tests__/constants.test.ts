import { describe, it, expect } from "vitest"
import {
  MAX_PARTY_SIZE,
  SLOT_DURATION_MINUTES,
  SEED_DAYS_AHEAD,
  LUNCH_STARTS,
  DINNER_STARTS,
  SHIPPING_RATES,
  SHIPPING_RATE_DEFAULT,
  classifyRefundMagnitudeBand,
} from "../constants.js"
import { COUPON_REJECTED_CODE } from "../cart.types.js"

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

  // D1 — the checkout coupon fail-closed abort code is a WIRE value: the
  // create_checkout tool returns it and the API checkout route keys the 422
  // mapping on it. Pin the literal so neither side drifts.
  it("COUPON_REJECTED_CODE is the pinned wire literal", () => {
    expect(COUPON_REJECTED_CODE).toBe("COUPON_REJECTED")
  })
})

// BKL-166 (FE-D07 residual) — pin the two comparators of the single-sourced
// refund-band classifier at SYNTHETIC thresholds so the boundary semantics are
// asserted independently of the real env-backed R$500 / R$1000 values:
//   - ESCALATE uses `>=` (isAtOrAboveMoneyBand, FE-T03/D2) — inclusive at the edge
//   - CONFIRM  uses `>`  (isAboveMoneyBand)                 — EXCLUSIVE at the edge
// This is the unit complement of the cross-bundle parity integration test
// (apps/api refund-band-channel-parity.test.ts), which drives real bundles.
describe("classifyRefundMagnitudeBand — comparator boundaries", () => {
  // Synthetic, deliberately not the real constants: confirm=100, escalate=200.
  const CONFIRM = 100
  const ESCALATE = 200
  const band = (amount: number) =>
    classifyRefundMagnitudeBand(amount, CONFIRM, ESCALATE)

  it("below the confirm threshold → EXECUTE", () => {
    expect(band(0)).toBe("EXECUTE")
    expect(band(50)).toBe("EXECUTE")
  })

  it("EXACTLY the confirm threshold stays EXECUTE (CONFIRM is strict >)", () => {
    expect(band(CONFIRM)).toBe("EXECUTE")
  })

  it("just above the confirm threshold → CONFIRM (first confirm value)", () => {
    expect(band(CONFIRM + 1)).toBe("CONFIRM")
  })

  it("between confirm and escalate → CONFIRM; just below escalate stays CONFIRM", () => {
    expect(band(150)).toBe("CONFIRM")
    expect(band(ESCALATE - 1)).toBe("CONFIRM")
  })

  it("EXACTLY the escalate threshold → ESCALATE (escalate is inclusive >=)", () => {
    expect(band(ESCALATE)).toBe("ESCALATE")
  })

  it("above the escalate threshold → ESCALATE", () => {
    expect(band(ESCALATE + 1)).toBe("ESCALATE")
    expect(band(10_000)).toBe("ESCALATE")
  })

  it("escalate dominates when thresholds coincide (>= wins over >)", () => {
    // Degenerate config: confirm == escalate. At the shared edge, ESCALATE's
    // inclusive `>=` is checked first, so the value escalates rather than confirms.
    expect(classifyRefundMagnitudeBand(100, 100, 100)).toBe("ESCALATE")
  })
})
