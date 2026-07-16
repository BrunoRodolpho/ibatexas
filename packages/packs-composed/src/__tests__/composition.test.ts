import { describe, expect, it } from "vitest"

import {
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
  IBATEXAS_COMPOSED_PACKS,
  composedIntentKinds,
} from "../index.js"
import { CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS } from "@ibatexas/pack-orders"
import { getRefundEscalateThresholdCentavos } from "@ibatexas/pack-payments"
import { MONEY_BAND_1000_CENTAVOS } from "@ibatexas/types"

describe("@ibatexas/packs-composed", () => {
  it("composes exactly the six first-party packs, with distinct ids", () => {
    expect(IBATEXAS_COMPOSED_PACKS).toHaveLength(6)
    const ids = IBATEXAS_COMPOSED_PACKS.map((p) => p.id)
    expect(new Set(ids).size).toBe(6)
    expect(ids).toEqual([
      "ibatexas/pack-orders",
      "ibatexas/pack-payments",
      "ibatexas/pack-reservations",
      "ibatexas/pack-customer-onboarding",
      "ibatexas/pack-whatsapp",
      "ibatexas/pack-ops",
    ])
  })

  it("composes one capability planner per pack", () => {
    expect(IBATEXAS_COMPOSED_CAPABILITY_PLANNERS).toHaveLength(6)
    for (const planner of IBATEXAS_COMPOSED_CAPABILITY_PLANNERS) {
      expect(typeof planner.plan).toBe("function")
    }
  })

  it("composedIntentKinds() is the deduplicated union of the packs' intents", () => {
    const kinds = composedIntentKinds()
    // Deduplicated…
    expect(new Set(kinds).size).toBe(kinds.length)
    // …and exactly the union of what the packs declare.
    const declared = new Set<string>(
      IBATEXAS_COMPOSED_PACKS.flatMap((p) => [...p.intents]),
    )
    expect(new Set(kinds)).toEqual(declared)
    // One representative kind per pack domain.
    expect(kinds).toEqual(
      expect.arrayContaining([
        "order.cart.ensure",
        "payment.charge.create",
        "reservation.create",
        "customer.create",
        "whatsapp.message.send",
        "product.availability.set",
      ]),
    )
  })

  // FE-T02 — pack-orders' checkout-confirm ladder and pack-payments'
  // refund-escalate ladder must resolve the SAME R$1000 money-band
  // boundary from the shared `@ibatexas/types` constant, not independent
  // literals. Env unset here, so payments resolves its (env-overridable)
  // default — which must equal the shared constant too.
  it("pack-orders and pack-payments resolve the same R$1000 money-band constant", () => {
    expect(MONEY_BAND_1000_CENTAVOS).toBe(100_000)
    expect(CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS).toBe(
      MONEY_BAND_1000_CENTAVOS,
    )
    expect(getRefundEscalateThresholdCentavos()).toBe(MONEY_BAND_1000_CENTAVOS)
  })
})
