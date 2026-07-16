// Shared business constants — single source of truth.
// Import these instead of hardcoding magic numbers.

/** Maximum seats per reservation */
export const MAX_PARTY_SIZE = 20

/** Default slot duration in minutes */
export const SLOT_DURATION_MINUTES = 90

/** Number of days ahead to seed time-slots */
export const SEED_DAYS_AHEAD = 30

/** Lunch service start times */
export const LUNCH_STARTS = ["11:30", "13:00"] as const

/** Dinner service start times */
export const DINNER_STARTS = ["18:30", "20:00", "21:30"] as const

// ─── Shipping rate config ──────────────────────────────────────────────────────

export interface ShippingRate {
  pac: { price: number; days: number }
  sedex: { price: number; days: number }
}

/**
 * Static shipping rates by CEP first-digit region.
 * Prices in centavos, days = estimated business days.
 * Phase 2 will replace with Correios/EasyPost API integration.
 */
export const SHIPPING_RATES: Record<number, ShippingRate> = {
  1: { pac: { price: 1200, days: 3 }, sedex: { price: 2200, days: 1 } },  // SP
  2: { pac: { price: 1800, days: 5 }, sedex: { price: 3200, days: 2 } },  // RJ / ES
  3: { pac: { price: 1500, days: 4 }, sedex: { price: 2800, days: 2 } },  // MG
  4: { pac: { price: 2500, days: 7 }, sedex: { price: 4200, days: 3 } },  // BA / SE
  5: { pac: { price: 2800, days: 8 }, sedex: { price: 4800, days: 4 } },  // PE / AL
  6: { pac: { price: 3000, days: 9 }, sedex: { price: 5200, days: 4 } },  // CE
  7: { pac: { price: 2200, days: 6 }, sedex: { price: 3800, days: 3 } },  // DF / GO / TO
  8: { pac: { price: 1800, days: 5 }, sedex: { price: 3200, days: 2 } },  // PR / SC / RS
  9: { pac: { price: 2800, days: 8 }, sedex: { price: 4600, days: 4 } },  // MT
}

/** Fallback when CEP first digit doesn't match a known region */
export const SHIPPING_RATE_DEFAULT: ShippingRate = {
  pac: { price: 2500, days: 7 },
  sedex: { price: 4200, days: 3 },
}

// ─── Money-band escalation boundary (centavos) ──────────────────────────
// FE-T02: single source for the R$1000 (100_000 centavos) boundary shared
// by `@ibatexas/pack-orders`' checkout-confirm ladder and
// `@ibatexas/pack-payments`' refund-escalate ladder. The two ladders
// currently apply DIVERGENT comparators at this exact boundary — orders
// confirms AT-OR-ABOVE it (`>=`, via `@adjudicate/primitives`'
// `createConfirmGuard({ comparator: ">=" })`), payments escalates
// STRICTLY ABOVE it (`>`). This file pins the shared VALUE (and both
// comparator directions, below) so the divergence is visible in one
// place; each call site keeps evaluating its own comparator, so no
// decision changes for any amount. FE-T03 will reconcile the divergence
// (payments' refund-escalate call site flips to `isAtOrAboveMoneyBand`).

/** R$1000 in centavos — the shared money-band escalation boundary. */
export const MONEY_BAND_1000_CENTAVOS = 100_000

/**
 * `amountCentavos >= thresholdCentavos`. This is
 * `@ibatexas/pack-orders`' checkout-confirm ladder's CURRENT comparator
 * (expressed declaratively via `createConfirmGuard`'s `comparator: ">="`
 * rather than a direct call to this helper) — documented here so both
 * operators are visible in one place, and available as the FE-T03 flip
 * target for the refund-escalate ladder below.
 */
export function isAtOrAboveMoneyBand(
  amountCentavos: number,
  thresholdCentavos: number,
): boolean {
  return amountCentavos >= thresholdCentavos
}

/**
 * `amountCentavos > thresholdCentavos`. This is
 * `@ibatexas/pack-payments`' refund-escalate ladder's CURRENT comparator
 * (see `getRefundEscalateThresholdCentavos` in `@ibatexas/pack-payments`).
 */
export function isAboveMoneyBand(
  amountCentavos: number,
  thresholdCentavos: number,
): boolean {
  return amountCentavos > thresholdCentavos
}
