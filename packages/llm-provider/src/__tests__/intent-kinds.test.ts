// Tests for KNOWN_INTENT_KINDS — the cross-Pack intent union consumed by
// `validateEnforceConfig` from `@adjudicate/core/kernel`.
//
// The set covers six Packs today (pack-orders + pack-reservations +
// pack-whatsapp + pack-payments-pix + pack-customer-onboarding + pack-payments).
// Future Packs (loyalty, promotions, auth) extend `intent-kinds.ts` further.

import { describe, it, expect } from "vitest"
import { KNOWN_INTENT_KINDS } from "../intent-kinds.js"

describe("KNOWN_INTENT_KINDS", () => {
  it("contains every order.* intent kind from @ibatexas/pack-orders (post W5-2)", () => {
    // Mirrors the OrderIntentKind union in
    // packages/pack-orders/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("order.cart.ensure")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.item.add")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.item.update")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.item.remove")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.cart.sync")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.coupon.apply")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.checkout.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.pix.details.set")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.cancel")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.cancel.system")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.amend.request")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.amend.add_item")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.amend.update_qty")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.amend.remove_item")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.address.change")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.type.switch")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.note.add")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.review.submit")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.reorder")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.projection.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.status.transition")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("order.status.reconcile")).toBe(true)
  })

  it("contains every payment.* intent kind from @ibatexas/pack-payments (W5-1)", () => {
    // Mirrors the PaymentIntentKind union in
    // packages/pack-payments/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("payment.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.charge.create")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.charge.confirm")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.charge.fail")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.charge.expire")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.charge.cancel")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.pix.regenerate")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.method.switch")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.retry")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.refund.issue")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.refund.confirm")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.dispute.open")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.cash.confirm")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.waive")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.status.force")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.status.transition")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("payment.status.reconcile")).toBe(true)
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

  it("contains every whatsapp.* intent kind from @ibatexas/pack-whatsapp (post W5-6)", () => {
    // Mirrors the WhatsAppIntentKind union in
    // packages/pack-whatsapp/src/types.ts.
    expect(KNOWN_INTENT_KINDS.has("whatsapp.message.send")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.template.send")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("whatsapp.session.handover")).toBe(true)
    expect(KNOWN_INTENT_KINDS.has("conversation.message.append")).toBe(true)
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

  it("has the expected size today (22 order + 8 reservation + 4 whatsapp + 3 pix + 17 payment + 8 customer = 62)", () => {
    // Post-W5 count breakdown:
    //   22 — pack-orders (W5-2 expansion)
    //    8 — pack-reservations
    //    4 — pack-whatsapp (W5-6 adds conversation.message.append)
    //    3 — pack-payments-pix (PIX-specific)
    //   17 — pack-payments (W5-1 new)
    //    8 — pack-customer-onboarding
    //   --
    //   62 distinct kinds (≥60 target per W5-4 acceptance criterion).
    //
    // This number changes when:
    //   - any first-party Pack adds/removes an intent kind
    //   - a future Pack (auth, loyalty, promotions) extends the union
    expect(KNOWN_INTENT_KINDS.size).toBe(62)
  })

  it("meets the W5-4 acceptance criterion (≥60 kinds)", () => {
    expect(KNOWN_INTENT_KINDS.size).toBeGreaterThanOrEqual(60)
  })

  it("has no duplicate entries (Set construction guarantees this)", () => {
    const kinds = [...KNOWN_INTENT_KINDS]
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it("excludes medusa.* internal egress namespace (W5-7 policy)", () => {
    // The 13 medusa.* kinds are an internal egress wrapper, not part of
    // the user-facing intent taxonomy. Documented in decisions-log.md D10.
    expect(KNOWN_INTENT_KINDS.has("medusa.admin.order.edit.confirm")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("medusa.cart.line_items.add")).toBe(false)
    expect(KNOWN_INTENT_KINDS.has("medusa.payment_collection.create")).toBe(false)
  })

  it("returns a Set whose entries are strings", () => {
    for (const kind of KNOWN_INTENT_KINDS) {
      expect(typeof kind).toBe("string")
      expect(kind.length).toBeGreaterThan(0)
    }
  })
})
