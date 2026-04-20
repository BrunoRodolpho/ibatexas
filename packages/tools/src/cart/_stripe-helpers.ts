// Shared Stripe helpers for cart tools (cancel, amend, PIX lifecycle).
// getStripe() mirrors the pattern in create-checkout.ts.

import Stripe from "stripe"

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error("STRIPE_SECRET_KEY not set")
  return new Stripe(key)
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
