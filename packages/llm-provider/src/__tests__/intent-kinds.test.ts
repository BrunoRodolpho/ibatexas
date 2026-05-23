// Tests for KNOWN_INTENT_KINDS — the cross-Pack intent union consumed by
// `validateEnforceConfig` from `@adjudicate/core/kernel`.
//
// The set covers five Packs today (pack-orders + pack-reservations +
// pack-whatsapp + pack-payments-pix + pack-customer-onboarding). Future
// Packs (loyalty, promotions, auth) extend `intent-kinds.ts` further.

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

  it("contains every reservation.* intent kind from @ibatexas/pack-reservations", () => {
    // Mirrors the ReservationIntentKind union in
    // packages/pack-reservations/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("reservation.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.modify")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.cancel")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.checkin")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.complete")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.no_show.mark")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.waitlist.join")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("reservation.waitlist.notify")).toBe(true)
  })

  it("contains every whatsapp.* intent kind from @ibatexas/pack-whatsapp", () => {
    // Mirrors the WhatsAppIntentKind union in
    // packages/pack-whatsapp/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("whatsapp.message.send")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.template.send")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.session.handover")).toBe(true)
  })

  it("contains every pix.charge.* intent kind from @adjudicate/pack-payments-pix", () => {
    expect(KNOWN_INTENT_KINDS.has("pix.charge.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("pix.charge.confirm")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("pix.charge.refund")).toBe(true)
  })

  it("contains every customer.* intent kind from @ibatexas/pack-customer-onboarding", () => {
    // Mirrors the CustomerOnboardingIntentKind union in
    // packages/pack-customer-onboarding/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("customer.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.profile.update")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.preferences.update")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.pix.details.save")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.address.add")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.address.remove")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.anonymize")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("customer.anonymize.cancel")).toBe(true)
  })

  it("excludes kinds from packs not yet built", () => {
    // Future-pack kinds (session/loyalty/welcome_credit go to subsequent
    // packs per task-21 scope notes; whatsapp.handoff/followup/outreach
    // belong to follow-up whatsapp tasks). They MUST NOT be in the set.
    expect(KNOWN_INTENT_KINDS.has("customer.session.create")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("customer.loyalty.redeem")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("customer.welcome_credit.grant")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.handoff.request")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.followup.schedule")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.outreach.send")).toBe(false)
  })

  it("excludes nonsense kinds", () => {
    expect(KNOWN_INTENT_KINDS.has("")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("nonsense")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("order.bogus")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("order.cart.ENSURE")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("ORDER.CART.ENSURE")).toBe(false)
  })

  it("has the expected size today (10 order + 8 reservation + 3 whatsapp + 3 pix + 8 customer = 32)", () => {
    // This number changes when:
    //   - pack-orders adds/removes an OrderIntentKind
    //   - pack-reservations adds/removes a ReservationIntentKind
    //   - pack-whatsapp adds/removes a WhatsAppIntentKind
    //   - pack-payments-pix adds/removes a PixIntentKind
    //   - pack-customer-onboarding adds/removes a CustomerOnboardingIntentKind
    //   - a future Pack (auth, loyalty, promotions) extends the union
    // Update the literal below when any of the above happens.
    expect(KNOWN_INTENT_KINDS.size).toBe(32)
  })

  it("returns a Set whose entries are strings", () => {
    for (const kind of KNOWN_INTENT_KINDS) {
      expect(typeof kind).toBe("string")
      expect(kind.length).toBeGreaterThan(0)
    }
  })
})
