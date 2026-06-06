// Barrel export for the Stripe egress wrapper.
//
// Callers should import `stripeAdjudicated` (and the typed errors) from
// `@ibatexas/tools/stripe` rather than reaching into `adjudicated.js`
// directly.

export {
  stripeAdjudicated,
  stripeWrapperPolicyBundle,
  STRIPE_INTENT_KINDS,
  StripeAdjudicateRefusedError,
  StripeAdjudicateDeferredError,
  StripeAdjudicateNeedsReviewError,
  __setStripeClientForTests,
} from "./adjudicated.js"

export type {
  StripeIntentKind,
  StripeWrapperState,
  StripeAdjudicatedArgs,
} from "./adjudicated.js"
