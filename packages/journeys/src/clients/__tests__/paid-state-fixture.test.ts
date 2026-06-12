// paid-state-fixture.test.ts — T2-1 unit coverage:
//   • CONTAINMENT: every signing entry point refuses without
//     IBX_TEST_FINGERPRINT (the authFixture precedent — D-010).
//   • Delivery contract: POSTs the raw signed payload to the real route path
//     with a verifiable stripe-signature header; non-200 → named error;
//     duplicate ack surfaced.
//   • awaitPaidState barrier: settles on paid; times out with a named error.

import { afterEach, describe, expect, it, vi } from "vitest"
import Stripe from "stripe"

import {
  awaitPaidState,
  firePaidStateWebhook,
  PaidStateBarrierTimeoutError,
  PaidStateFingerprintRequiredError,
  PaidStateOptionError,
  PaidStateWebhookError,
} from "../paid-state-fixture.js"
import type { DomainPaymentRow } from "../../oracle/domain-reader.js"

const SECRET = "whsec_unit_fixture_secret"

function stubFingerprint(): void {
  vi.stubEnv("IBX_TEST_FINGERPRINT", "ibx-test-unit")
}

afterEach(() => {
  vi.unstubAllEnvs()
})

function paymentRow(overrides: Partial<DomainPaymentRow> = {}): DomainPaymentRow {
  return {
    id: "pay_01",
    orderId: "order_01",
    status: "cash_pending",
    method: "cash",
    amountInCentavos: 8900,
    stripePaymentIntentId: null,
    version: 1,
    createdAt: new Date(),
    ...overrides,
  }
}

describe("firePaidStateWebhook — containment", () => {
  it("REFUSES without IBX_TEST_FINGERPRINT (signing is a test-plane-only power)", async () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "")
    await expect(
      firePaidStateWebhook({
        baseUrl: "http://localhost:3001",
        webhookSecret: SECRET,
        orderId: "order_01",
        amountInCentavos: 8900,
      }),
    ).rejects.toThrow(PaidStateFingerprintRequiredError)
  })

  it("refuses an empty webhookSecret / baseUrl (named, fail-fast)", async () => {
    stubFingerprint()
    await expect(
      firePaidStateWebhook({
        baseUrl: "",
        webhookSecret: SECRET,
        orderId: "order_01",
        amountInCentavos: 8900,
      }),
    ).rejects.toThrow(PaidStateOptionError)
    await expect(
      firePaidStateWebhook({
        baseUrl: "http://localhost:3001",
        webhookSecret: "",
        orderId: "order_01",
        amountInCentavos: 8900,
      }),
    ).rejects.toThrow(PaidStateOptionError)
  })
})

describe("firePaidStateWebhook — delivery contract", () => {
  it("POSTs the raw signed payload to /api/webhooks/stripe; the header verifies against the route's verifier", async () => {
    stubFingerprint()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: never, init: never) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const result = await firePaidStateWebhook({
      baseUrl: "http://stack.test:3001",
      webhookSecret: SECRET,
      orderId: "order_01",
      amountInCentavos: 8900,
      customerId: "cust_01",
      fetchImpl,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("http://stack.test:3001/api/webhooks/stripe")
    const init = calls[0]!.init
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")

    // The signed body verifies with the EXACT verifier the route uses.
    const body = init.body as string
    const event = new Stripe("sk_test_unit").webhooks.constructEvent(
      body,
      headers["stripe-signature"]!,
      SECRET,
    )
    expect(event.id).toBe(result.eventId)
    const pi = event.data.object as Stripe.PaymentIntent
    expect(pi.id).toBe(result.paymentIntentId)
    expect(pi.metadata["medusaOrderId"]).toBe("order_01")
    expect(pi.metadata["customerId"]).toBe("cust_01")
    expect(result.duplicate).toBe(false)
  })

  it("surfaces the route's duplicate ack", async () => {
    stubFingerprint()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 })) as typeof fetch
    const result = await firePaidStateWebhook({
      baseUrl: "http://stack.test:3001",
      webhookSecret: SECRET,
      orderId: "order_01",
      amountInCentavos: 8900,
      fetchImpl,
    })
    expect(result.duplicate).toBe(true)
  })

  it("a non-200 (e.g. signature 400) throws the named error with the body", async () => {
    stubFingerprint()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "Webhook signature verification failed" }), {
        status: 400,
      })) as typeof fetch
    await expect(
      firePaidStateWebhook({
        baseUrl: "http://stack.test:3001",
        webhookSecret: SECRET,
        orderId: "order_01",
        amountInCentavos: 8900,
        fetchImpl,
      }),
    ).rejects.toThrow(PaidStateWebhookError)
  })
})

describe("awaitPaidState — projection barrier for the paid transition", () => {
  it("settles once the order's active payment reaches paid", async () => {
    const rows: Array<DomainPaymentRow | null> = [
      paymentRow({ status: "cash_pending" }),
      paymentRow({ status: "paid", version: 2 }),
    ]
    const domain = {
      activePaymentByOrderId: vi.fn(async () => rows.shift() ?? paymentRow({ status: "paid" })),
    }
    const settled = await awaitPaidState(domain, "order_01", { timeoutMs: 2_000, pollMs: 1 })
    expect(settled.status).toBe("paid")
    expect(domain.activePaymentByOrderId).toHaveBeenCalledWith("order_01")
  })

  it("times out with a named error carrying the last observed state", async () => {
    const domain = {
      activePaymentByOrderId: vi.fn(async () => paymentRow({ status: "cash_pending" })),
    }
    await expect(
      awaitPaidState(domain, "order_01", { timeoutMs: 25, pollMs: 1 }),
    ).rejects.toThrow(PaidStateBarrierTimeoutError)
    await expect(
      awaitPaidState(domain, "order_01", { timeoutMs: 25, pollMs: 1 }),
    ).rejects.toThrow(/status=cash_pending/)
  })

  it("a missing payment row never passes vacuously (times out, named)", async () => {
    const domain = { activePaymentByOrderId: vi.fn(async () => null) }
    await expect(
      awaitPaidState(domain, "order_01", { timeoutMs: 25, pollMs: 1 }),
    ).rejects.toThrow(/no active payment row/)
  })
})
