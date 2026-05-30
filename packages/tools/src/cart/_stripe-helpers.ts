// Shared Stripe helpers for cart tools (cancel, amend, PIX lifecycle).
// getStripe() mirrors the pattern in create-checkout.ts.

import Stripe from "stripe"

// P2-MEM-STRIPENEW: memoize a module-level Stripe client so cart tools reuse one
// HTTP agent/connection pool instead of constructing `new Stripe(key)` on every
// call. Lazy so the key is still read from env at first use. Construction-only —
// no Stripe config options change.
let stripeClient: Stripe | undefined

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error("STRIPE_SECRET_KEY not set")
  if (!stripeClient) stripeClient = new Stripe(key)
  return stripeClient
}

/**
 * Cancel a Stripe PaymentIntent. Safe to call on already-cancelled/succeeded/expired PIs.
 * Used after order cancel, amend, and PIX expiry to prevent stale QR code scans.
 */
export async function cancelStalePaymentIntent(paymentIntentId: string): Promise<void> {
  const stripe = getStripe()
  try {
    await stripe.paymentIntents.cancel(paymentIntentId)
  } catch (err: unknown) {
    const stripeErr = err as { code?: string }
    // PI already cancelled, succeeded, or expired — safe to ignore
    if (stripeErr.code === "payment_intent_unexpected_state") return
    throw err
  }
}
