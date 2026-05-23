// Tests for KNOWN_INTENT_KINDS — the cross-Pack intent union consumed by
// `validateEnforceConfig` from `@adjudicate/core/kernel`.
//
// The set is small today (pack-orders + pack-payments-pix only). Future
// Packs land in tasks 09 / 10 / 21 and must extend `intent-kinds.ts` —
// the TODO markers there are the contract.

import { describe, it, expect } from "vitest"
import { KNOWN_INTENT_KINDS } from "../intent-kinds.js"

describe("KNOWN_INTENT_KINDS", () => {
  it("contains every order.* intent kind from @ibatexas/pack-orders", () => {
    // Mirrors the OrderIntentKind union in
    // packages/pack-orders/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("order.cart.ensure")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.item.add")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.item.update")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.item.remove")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.coupon.apply")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.checkout.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.cancel")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.cancel.system")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.amend.request")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.note.add")).toBe(true)
  })

  it("contains every pix.charge.* intent kind from @adjudicate/pack-payments-pix", () => {
    expect(KNOWN_INTENT_KINDS.has("pix.charge.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("pix.charge.confirm")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("pix.charge.refund")).toBe(true)
  })

  it("excludes kinds from packs not yet built", () => {
    // These will be added in tasks 09 / 10 / 21 — see TODO markers in
    // intent-kinds.ts. Until then, they MUST NOT be in the set.
    expect(KNOWN_INTENT_KINDS.has("reservation.create")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.message.send")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("customer.create")).toBe(false)
  })

  it("excludes nonsense kinds", () => {
    expect(KNOWN_INTENT_KINDS.has("")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("nonsense")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("order.bogus")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("order.cart.ENSURE")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("ORDER.CART.ENSURE")).toBe(false)
  })

  it("has the expected size today (10 order + 3 pix = 13)", () => {
    // This number changes when:
    //   - pack-orders adds/removes an OrderIntentKind
    //   - pack-payments-pix adds/removes a PixIntentKind
    //   - tasks 09 / 10 / 21 land and extend the union
    // Update the literal below when any of the above happens.
    expect(KNOWN_INTENT_KINDS.size).toBe(13)
  })

  it("returns a Set whose entries are strings", () => {
    for (const kind of KNOWN_INTENT_KINDS) {
      expect(typeof kind).toBe("string")
      expect(kind.length).toBeGreaterThan(0)
    }
  })
})
