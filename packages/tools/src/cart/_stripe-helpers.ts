// Shared Stripe helpers for cart tools (cancel, amend, PIX lifecycle).
//
// ── W7 P5 — kernel-gated mutations ─────────────────────────────────────
//
// `cancelStalePaymentIntent` now routes through `stripeAdjudicated`
// (`packages/tools/src/stripe/adjudicated.ts`) — the previous direct
// `stripe.paymentIntents.cancel(...)` call bypassed the kernel.
//
// `getStripe()` is retained for backward compatibility (read-only
// callers and tests that mock the bare client). Per D8 (parallel
// surfaces) it remains exported until call-site migrations finish.

import Stripe from "stripe"
import { getAuditSink } from "@ibatexas/audit-sink"
import { stripeAdjudicated } from "../stripe/adjudicated.js"

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error("STRIPE_SECRET_KEY not set")
  return new Stripe(key)
}

/**
 * Cancel a Stripe PaymentIntent. Safe to call on already-cancelled/succeeded/expired PIs.
 * Used after order cancel, amend, and PIX expiry to prevent stale QR code scans.
 *
 * Routes through `stripeAdjudicated.paymentIntents.cancel` so the
 * cancellation is recorded as a `stripe.payment_intent.cancel`
 * envelope + audit record.
 */
export async function cancelStalePaymentIntent(paymentIntentId: string): Promise<void> {
  try {
    await stripeAdjudicated.paymentIntents.cancel(paymentIntentId, {
      sourceSubject: "tool:cart-helpers:cancelStalePaymentIntent",
      auditSink: getAuditSink(),
    })
  } catch (err: unknown) {
    const stripeErr = err as { code?: string }
    // PI already cancelled, succeeded, or expired — safe to ignore
    if (stripeErr.code === "payment_intent_unexpected_state") return
    throw err
  }
}
