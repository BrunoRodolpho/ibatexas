// clients/stripe-webhook-signer.ts — T2-1: local Stripe webhook signing +
// realistic `payment_intent.succeeded` event construction for the paid-state
// fixture.
//
// The asserted PAID transition must be driven through the REAL
// signature-verified Stripe webhook route (`POST /api/webhooks/stripe`,
// apps/api/src/routes/stripe-webhook.ts) — never forged into projections.
// On the ephemeral test plane there is no live Stripe, so the harness IS
// "test-plane Stripe": it signs the event locally with the stack's own
// STRIPE_WEBHOOK_SECRET (.env.test, generated per machine) and the route's
// `stripe.webhooks.constructEvent` verifies it exactly as it would a real
// delivery.
//
// ── Stripe's signature scheme (what constructEvent verifies) ────────────────
//   header:  Stripe-Signature: t=<unix-seconds>,v1=<hex>
//   v1    :  HMAC-SHA256(key = webhook secret, message = `${t}.${rawBody}`)
//   plus a timestamp tolerance check (constructEvent default: 300s).
// The unit test proves byte-compatibility by verifying this module's output
// with the REAL `stripe` library's constructEvent (the same verifier the
// route uses) under a shared test secret.
//
// ── Contract pins mirrored from the route ───────────────────────────────────
//   • livemode is pinned FALSE: the route binds event.livemode to the API
//     key's mode (P3-SEC-STRIPESRC, stripe-webhook.ts) and the test stack's
//     STRIPE_SECRET_KEY is always an `sk_test_` placeholder — a livemode
//     event would be refused with 400 before any processing.
//   • event.id is the route's Redis idempotency key AND the reconcile
//     envelope's nonce — every fixture invocation mints a FRESH evt id so the
//     route never 200-dedupes the fixture's delivery.
//   • data.object.metadata.medusaOrderId drives handlePaymentSucceeded's
//     order resolution + the T2-1 reconcile fallback; in production that
//     metadata is the SUT's own stamp on the PaymentIntent (capturePayment /
//     W8-V2), so the fixture carrying it is shape-faithful.

import { createHmac, randomBytes } from "node:crypto"

// ── Signature ────────────────────────────────────────────────────────────────

export interface StripeSignatureOptions {
  /** Unix SECONDS for the `t=` component (default: now). */
  readonly timestampSec?: number
}

/**
 * Compute the `Stripe-Signature` header value for a raw payload string:
 * `t=<ts>,v1=<hmac-sha256-hex of "<ts>.<payload>">` — the exact scheme
 * `stripe.webhooks.constructEvent` verifies.
 */
export function stripeSignatureHeader(
  payload: string,
  webhookSecret: string,
  opts: StripeSignatureOptions = {},
): string {
  if (webhookSecret === "") {
    throw new StripeSignerOptionError("stripeSignatureHeader: webhookSecret must be non-empty")
  }
  const t = opts.timestampSec ?? Math.floor(Date.now() / 1000)
  const v1 = createHmac("sha256", webhookSecret).update(`${t}.${payload}`).digest("hex")
  return `t=${t},v1=${v1}`
}

/** Invalid signer/event options (named, fail-fast). */
export class StripeSignerOptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StripeSignerOptionError"
  }
}

// ── Event construction ───────────────────────────────────────────────────────

/** Stripe-style opaque id: `<prefix>_<24 hex>` (shape-faithful, test-plane). */
export function stripeStyleId(prefix: "evt" | "pi"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`
}

export interface PaymentIntentSucceededEventOptions {
  /**
   * The DOMAIN order id (the order_projections id — for storefront-created
   * orders this is the raw Medusa order id). Lands in
   * `data.object.metadata.medusaOrderId`.
   */
  readonly orderId: string
  /**
   * PaymentIntent amount in CENTAVOS (Stripe minor units — CLAUDE.md rule 2).
   * MUST equal the order's total: capturePayment's stale-PI guard compares
   * `event.data.object.amount` against the Medusa order total in centavos.
   */
  readonly amountInCentavos: number
  /** Override the PI id (default: fresh `pi_<hex>`). */
  readonly paymentIntentId?: string
  /** Override the event id (default: fresh `evt_<hex>`) — Redis idempotency key. */
  readonly eventId?: string
  /** Optional domain customerId (production PIs carry it — checkout stamps it). */
  readonly customerId?: string
  /** Unix SECONDS for `created` (default: now). */
  readonly createdSec?: number
}

export interface PaymentIntentSucceededEvent {
  readonly eventId: string
  readonly paymentIntentId: string
  /** The exact raw JSON string to POST (sign THIS — byte-for-byte). */
  readonly payload: string
}

/**
 * Build a realistic `payment_intent.succeeded` event body. Returns the raw
 * JSON string (signing is byte-sensitive — never re-serialize) plus the ids.
 */
export function buildPaymentIntentSucceededEvent(
  opts: PaymentIntentSucceededEventOptions,
): PaymentIntentSucceededEvent {
  if (opts.orderId === "") {
    throw new StripeSignerOptionError("buildPaymentIntentSucceededEvent: orderId must be non-empty")
  }
  if (!Number.isInteger(opts.amountInCentavos) || opts.amountInCentavos <= 0) {
    throw new StripeSignerOptionError(
      `buildPaymentIntentSucceededEvent: amountInCentavos must be a positive integer (got ${String(opts.amountInCentavos)})`,
    )
  }
  const eventId = opts.eventId ?? stripeStyleId("evt")
  const paymentIntentId = opts.paymentIntentId ?? stripeStyleId("pi")
  const created = opts.createdSec ?? Math.floor(Date.now() / 1000)

  const event = {
    id: eventId,
    object: "event",
    api_version: "2024-06-20",
    created,
    // Pinned FALSE — see the module header (P3-SEC-STRIPESRC livemode binding).
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: paymentIntentId,
        object: "payment_intent",
        amount: opts.amountInCentavos,
        amount_received: opts.amountInCentavos,
        currency: "brl",
        status: "succeeded",
        livemode: false,
        created,
        last_payment_error: null,
        metadata: {
          medusaOrderId: opts.orderId,
          ...(opts.customerId !== undefined ? { customerId: opts.customerId } : {}),
        },
      },
    },
  }

  return { eventId, paymentIntentId, payload: JSON.stringify(event) }
}
