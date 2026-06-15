// clients/paid-state-fixture.ts — T2-1: paid-state fixture, kernel-routed.
//
// Drives an order's payment to PAID through the REAL signature-verified
// Stripe webhook route — NEVER by forging projections:
//
//   firePaidStateWebhook()  builds a realistic payment_intent.succeeded
//                           event (stripe-webhook-signer.ts), signs it
//                           locally with the test plane's
//                           STRIPE_WEBHOOK_SECRET, and POSTs it to
//                           `POST /api/webhooks/stripe`. The route verifies
//                           the signature + livemode, claims the Redis
//                           idempotency key, and enqueues the durable job;
//                           the processor then runs the SUT's own paid path:
//                           buildEnvelope(payment.status.reconcile,
//                           actor.principal="system") → adjudicate →
//                           Payment projection → NATS payment.status_changed
//                           → payment-lifecycle auto-confirm. The PAID
//                           transition therefore lands in intent_audit as a
//                           SYSTEM-actor envelope (sessionId
//                           `stripe-webhook:<evt id>`, hashed by the audit
//                           redactor) — audited state, not a forgery.
//
//   awaitPaidState()        projection barrier for the paid transition: polls
//                           the order's ACTIVE payment row via the read-only
//                           oracle reader until status === "paid" (the route
//                           is ack-then-async — BullMQ + subscriber lag sit
//                           between the 200 and the projection write).
//
// ── Governance (binding) ─────────────────────────────────────────────────────
//   • Reconciliation (T1b-1) is unaffected by construction: the system-actor
//     envelopes this fixture causes carry sourceSubject-derived sessionIds
//     that hash OUTSIDE any run namespace (D-015), and the asserted paid
//     state has audited envelopes — exactly the fixture-act governance rule.
//   • CONTAINMENT (the authFixture/JWT-helper precedent): signing webhooks is
//     the test plane's trust-anchor power. Every entry point REFUSES unless
//     IBX_TEST_FINGERPRINT is set (D-010 — only .env.test carries it), and
//     this module lives ONLY in @ibatexas/journeys (check-bypass leg 6 keeps
//     the package un-importable from apps/* and non-test packages/*).
//   • PRE-SEEDING ONLY for everything else: the order itself must have been
//     created through the public storefront surface (cart → items → checkout)
//     by earlier journey acts — this fixture never creates orders.
//
// ── What lands, per payment method (live-verified 2026-06-12) ────────────────
//   The Payment row reaches "paid" (kernel payment.status.reconcile EXECUTE)
//   for any active payment. ORDER auto-confirm (pending → confirmed) is a
//   separate subscriber effect that the SUT applies for electronic methods
//   ONLY — payment-lifecycle.ts deliberately skips `method === "cash"`
//   (cash confirms at handoff). Today's only executable storefront checkout
//   is cash (PIX/card payment-session init needs live Stripe — not on the
//   test plane), so journeys built on this fixture assert the PAYMENT plane
//   (paid) — not order auto-confirm.

import { TEST_FINGERPRINT_ENV } from "../harness/preflight.js"
import type { DomainPaymentRow, DomainReader } from "../oracle/domain-reader.js"
import {
  buildPaymentIntentSucceededEvent,
  stripeSignatureHeader,
  type PaymentIntentSucceededEventOptions,
} from "./stripe-webhook-signer.js"

// ── Named errors ─────────────────────────────────────────────────────────────

/**
 * The containment gate refused to sign: IBX_TEST_FINGERPRINT is absent.
 * Only the ephemeral test profile sets that var (D-010) — locally signing
 * Stripe webhooks against anything else is forbidden by construction.
 */
export class PaidStateFingerprintRequiredError extends Error {
  constructor(fn: string) {
    super(
      `${fn} refused: ${TEST_FINGERPRINT_ENV} is not set. The paid-state ` +
        "fixture signs Stripe webhook events ONLY inside the ephemeral test " +
        "profile (.env.test carries the fingerprint; dev/prod never do) — " +
        "this gate is governance, not a configuration hint.",
    )
    this.name = "PaidStateFingerprintRequiredError"
  }
}

/** The webhook route rejected the signed delivery (named, fail-fast). */
export class PaidStateWebhookError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(
      `firePaidStateWebhook: POST /api/webhooks/stripe -> ${status} ${body.slice(0, 300)} ` +
        "(a 400 here means signature/livemode verification failed — check " +
        "STRIPE_WEBHOOK_SECRET matches the running stack's .env.test)",
    )
    this.name = "PaidStateWebhookError"
    this.status = status
    this.body = body
  }
}

/** The paid transition never appeared on the oracle plane within the budget. */
export class PaidStateBarrierTimeoutError extends Error {
  constructor(orderId: string, timeoutMs: number, last: DomainPaymentRow | null) {
    super(
      `awaitPaidState: order ${orderId} active payment never reached "paid" within ${timeoutMs}ms ` +
        `(last observed: ${last === null ? "no active payment row" : `status=${last.status} method=${last.method}`})`,
    )
    this.name = "PaidStateBarrierTimeoutError"
  }
}

/** Invalid fixture options (named, fail-fast). */
export class PaidStateOptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PaidStateOptionError"
  }
}

// ── Containment gate ─────────────────────────────────────────────────────────

function requireTestFingerprint(fn: string): void {
  const fingerprint = process.env[TEST_FINGERPRINT_ENV]
  if (fingerprint === undefined || fingerprint.trim() === "") {
    throw new PaidStateFingerprintRequiredError(fn)
  }
}

// ── Webhook delivery ─────────────────────────────────────────────────────────

export interface FirePaidStateWebhookOptions
  extends Omit<PaymentIntentSucceededEventOptions, "createdSec"> {
  /** The SUT api base URL (e.g. http://localhost:3001). */
  readonly baseUrl: string
  /** The TEST PLANE's STRIPE_WEBHOOK_SECRET (.env.test — never a prod value). */
  readonly webhookSecret: string
  /** Injectable fetch (unit tests). Default: global fetch. */
  readonly fetchImpl?: typeof fetch
}

export interface PaidStateWebhookResult {
  /** The minted Stripe event id (the route's idempotency key + reconcile nonce). */
  readonly eventId: string
  /** The minted PaymentIntent id. */
  readonly paymentIntentId: string
  /** True when the route answered duplicate (same evt id already claimed). */
  readonly duplicate: boolean
}

/**
 * Sign + deliver one `payment_intent.succeeded` event to the real webhook
 * route. Resolves once the route has acked (202-equivalent `200 {ok:true}` —
 * processing is async; await the projection with `awaitPaidState`).
 * REFUSES without IBX_TEST_FINGERPRINT (containment — see module header).
 */
export async function firePaidStateWebhook(
  options: FirePaidStateWebhookOptions,
): Promise<PaidStateWebhookResult> {
  requireTestFingerprint("firePaidStateWebhook")
  if (options.baseUrl === "") {
    throw new PaidStateOptionError("firePaidStateWebhook: baseUrl must be non-empty")
  }
  if (options.webhookSecret === "") {
    throw new PaidStateOptionError(
      "firePaidStateWebhook: webhookSecret must be non-empty (.env.test STRIPE_WEBHOOK_SECRET)",
    )
  }

  const { eventId, paymentIntentId, payload } = buildPaymentIntentSucceededEvent({
    orderId: options.orderId,
    amountInCentavos: options.amountInCentavos,
    ...(options.paymentIntentId !== undefined ? { paymentIntentId: options.paymentIntentId } : {}),
    ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
    ...(options.customerId !== undefined ? { customerId: options.customerId } : {}),
  })
  const signature = stripeSignatureHeader(payload, options.webhookSecret)

  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(`${options.baseUrl}/api/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  })
  const bodyText = await response.text().catch(() => "")
  if (response.status !== 200) {
    throw new PaidStateWebhookError(response.status, bodyText)
  }
  let duplicate = false
  try {
    duplicate = (JSON.parse(bodyText) as { duplicate?: boolean }).duplicate === true
  } catch {
    /* body shape is the route's contract; tolerate non-JSON 200s */
  }
  return { eventId, paymentIntentId, duplicate }
}

// ── Projection barrier for the paid transition ───────────────────────────────

export interface AwaitPaidStateOptions {
  /** Poll budget (default 30s — webhook ack → BullMQ → kernel → projection). */
  readonly timeoutMs?: number
  /** Poll interval (default 250ms). */
  readonly pollMs?: number
}

export const PAID_STATE_TIMEOUT_MS = 30_000
export const PAID_STATE_POLL_MS = 250

/**
 * Await the paid transition on the oracle plane: polls the order's ACTIVE
 * payment row (read-only oracle role) until `status === "paid"`. Returns the
 * settled row; throws `PaidStateBarrierTimeoutError` past the budget.
 */
export async function awaitPaidState(
  domain: Pick<DomainReader, "activePaymentByOrderId">,
  orderId: string,
  opts: AwaitPaidStateOptions = {},
): Promise<DomainPaymentRow> {
  const timeoutMs = opts.timeoutMs ?? PAID_STATE_TIMEOUT_MS
  const pollMs = opts.pollMs ?? PAID_STATE_POLL_MS
  const deadline = Date.now() + timeoutMs
  let last: DomainPaymentRow | null = null
  for (;;) {
    last = await domain.activePaymentByOrderId(orderId)
    if (last !== null && last.status === "paid") return last
    if (Date.now() >= deadline) throw new PaidStateBarrierTimeoutError(orderId, timeoutMs, last)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
