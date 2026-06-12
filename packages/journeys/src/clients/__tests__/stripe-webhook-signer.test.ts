// stripe-webhook-signer.test.ts — T2-1: the local signature construction must
// match Stripe's scheme BYTE-FOR-BYTE. The load-bearing proof: the REAL
// `stripe` library's `webhooks.constructEvent` — the exact verifier the route
// uses (apps/api/src/routes/stripe-webhook.ts:718) — accepts this module's
// header under a shared test secret, and rejects tampered payloads / wrong
// secrets / stale timestamps the same way it would for a real delivery.

import { describe, expect, it } from "vitest"
import Stripe from "stripe"

import {
  buildPaymentIntentSucceededEvent,
  stripeSignatureHeader,
  stripeStyleId,
  StripeSignerOptionError,
} from "../stripe-webhook-signer.js"

const SECRET = "whsec_shared_unit_test_secret"

/** The same construction the route does (sk key value irrelevant for verify). */
const stripeVerifier = new Stripe("sk_test_unit_verifier")

describe("stripeSignatureHeader — scheme compatibility with stripe's verifier", () => {
  it("produces t=<unix>,v1=<64-hex> in Stripe's format", () => {
    const header = stripeSignatureHeader('{"a":1}', SECRET, { timestampSec: 1_700_000_000 })
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
  })

  it("is accepted by the REAL stripe.webhooks.constructEvent (the route's verifier)", () => {
    const { payload, eventId, paymentIntentId } = buildPaymentIntentSucceededEvent({
      orderId: "order_unit_01",
      amountInCentavos: 8900,
    })
    const header = stripeSignatureHeader(payload, SECRET)
    const event = stripeVerifier.webhooks.constructEvent(payload, header, SECRET)
    expect(event.id).toBe(eventId)
    expect(event.type).toBe("payment_intent.succeeded")
    expect(event.livemode).toBe(false)
    const pi = event.data.object as Stripe.PaymentIntent
    expect(pi.id).toBe(paymentIntentId)
    expect(pi.amount).toBe(8900)
    expect(pi.metadata["medusaOrderId"]).toBe("order_unit_01")
  })

  it("a tampered payload fails the route's verifier", () => {
    const { payload } = buildPaymentIntentSucceededEvent({
      orderId: "order_unit_01",
      amountInCentavos: 8900,
    })
    const header = stripeSignatureHeader(payload, SECRET)
    const tampered = payload.replace("8900", "1")
    expect(() => stripeVerifier.webhooks.constructEvent(tampered, header, SECRET)).toThrow(
      /signature/i,
    )
  })

  it("a wrong secret fails the route's verifier", () => {
    const { payload } = buildPaymentIntentSucceededEvent({
      orderId: "order_unit_01",
      amountInCentavos: 8900,
    })
    const header = stripeSignatureHeader(payload, "whsec_other_secret")
    expect(() => stripeVerifier.webhooks.constructEvent(payload, header, SECRET)).toThrow(
      /signature/i,
    )
  })

  it("a stale timestamp (> 300s tolerance) fails the route's verifier", () => {
    const { payload } = buildPaymentIntentSucceededEvent({
      orderId: "order_unit_01",
      amountInCentavos: 8900,
    })
    const stale = Math.floor(Date.now() / 1000) - 600
    const header = stripeSignatureHeader(payload, SECRET, { timestampSec: stale })
    expect(() => stripeVerifier.webhooks.constructEvent(payload, header, SECRET)).toThrow(
      /timestamp|tolerance/i,
    )
  })

  it("refuses an empty secret (fail-fast, named error)", () => {
    expect(() => stripeSignatureHeader("{}", "")).toThrow(StripeSignerOptionError)
  })
})

describe("buildPaymentIntentSucceededEvent — realistic event shape", () => {
  it("pins livemode=false and carries the metadata the webhook handler reads", () => {
    const { payload } = buildPaymentIntentSucceededEvent({
      orderId: "order_unit_02",
      amountInCentavos: 12_345,
      customerId: "cust_01",
      eventId: "evt_fixed00000000000000000",
      paymentIntentId: "pi_fixed000000000000000000",
      createdSec: 1_700_000_000,
    })
    const parsed = JSON.parse(payload) as Record<string, never>
    expect(parsed).toMatchObject({
      id: "evt_fixed00000000000000000",
      object: "event",
      type: "payment_intent.succeeded",
      livemode: false,
      created: 1_700_000_000,
      data: {
        object: {
          id: "pi_fixed000000000000000000",
          object: "payment_intent",
          amount: 12_345,
          amount_received: 12_345,
          currency: "brl",
          status: "succeeded",
          livemode: false,
          metadata: { medusaOrderId: "order_unit_02", customerId: "cust_01" },
        },
      },
    })
  })

  it("mints fresh evt_/pi_ ids by default (the route's idempotency key must never collide)", () => {
    const a = buildPaymentIntentSucceededEvent({ orderId: "o", amountInCentavos: 1 })
    const b = buildPaymentIntentSucceededEvent({ orderId: "o", amountInCentavos: 1 })
    expect(a.eventId).toMatch(/^evt_[0-9a-f]{24}$/)
    expect(a.paymentIntentId).toMatch(/^pi_[0-9a-f]{24}$/)
    expect(a.eventId).not.toBe(b.eventId)
    expect(a.paymentIntentId).not.toBe(b.paymentIntentId)
  })

  it("refuses non-positive / non-integer amounts (prices are integer centavos)", () => {
    expect(() =>
      buildPaymentIntentSucceededEvent({ orderId: "o", amountInCentavos: 0 }),
    ).toThrow(StripeSignerOptionError)
    expect(() =>
      buildPaymentIntentSucceededEvent({ orderId: "o", amountInCentavos: 89.5 }),
    ).toThrow(StripeSignerOptionError)
    expect(() => buildPaymentIntentSucceededEvent({ orderId: "", amountInCentavos: 1 })).toThrow(
      StripeSignerOptionError,
    )
  })

  it("stripeStyleId shapes ids like Stripe's", () => {
    expect(stripeStyleId("evt")).toMatch(/^evt_[0-9a-f]{24}$/)
    expect(stripeStyleId("pi")).toMatch(/^pi_[0-9a-f]{24}$/)
  })
})
