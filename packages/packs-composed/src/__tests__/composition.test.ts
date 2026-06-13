import { describe, expect, it } from "vitest"

import {
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
  IBATEXAS_COMPOSED_PACKS,
  composedIntentKinds,
} from "../index.js"

describe("@ibatexas/packs-composed", () => {
  it("composes exactly the five first-party packs, with distinct ids", () => {
    expect(IBATEXAS_COMPOSED_PACKS).toHaveLength(5)
    const ids = IBATEXAS_COMPOSED_PACKS.map((p) => p.id)
    expect(new Set(ids).size).toBe(5)
    expect(ids).toEqual([
      "ibatexas/pack-orders",
      "ibatexas/pack-payments",
      "ibatexas/pack-reservations",
      "ibatexas/pack-customer-onboarding",
      "ibatexas/pack-whatsapp",
    ])
  })

  it("composes one capability planner per pack", () => {
    expect(IBATEXAS_COMPOSED_CAPABILITY_PLANNERS).toHaveLength(5)
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
      ]),
    )
  })
})
