/**
 * Guest checkout gating (CUS-023).
 *
 * The API supports a *card* checkout for unauthenticated guests (R0a): POST
 * /api/cart/checkout runs under `optionalAuth`, `verifyCartOwnership` allows a
 * guest cart, and the per-order access token minted on the response lets the
 * guest track the order without a session. But SEC-001
 * (`validateCheckoutComposition`) rejects cash/pix without a `customerId` — those
 * methods 401 server-side for a guest. So a guest may only complete a *card*
 * checkout; PIX / cash require signing in first.
 *
 * These pure helpers keep that policy out of the page component and under test
 * (apps/web has no @testing-library — logic lives in domain helpers).
 */

export type CheckoutPaymentMethod = 'pix' | 'card' | 'cash'

/** Payment methods a guest (unauthenticated) checkout may complete — card only. */
export const GUEST_PAYMENT_METHODS: readonly CheckoutPaymentMethod[] = ['card']

/** Login destination that returns the guest to checkout after signing in. */
export const CHECKOUT_LOGIN_HREF = '/entrar?next=/checkout'

/** True when `method` is completable by a guest (card); PIX / cash need a login. */
export function isGuestEligiblePaymentMethod(method: CheckoutPaymentMethod): boolean {
  return GUEST_PAYMENT_METHODS.includes(method)
}

/**
 * The payment methods to OFFER for the current auth state. Authenticated
 * customers get every method in `all`; guests get only the guest-eligible ones,
 * preserving the caller's ordering (and any upstream filtering, e.g. shipping).
 */
export function guestFilteredPaymentMethods(
  isAuthenticated: boolean,
  all: readonly CheckoutPaymentMethod[],
): CheckoutPaymentMethod[] {
  if (isAuthenticated) return [...all]
  return all.filter((method) => isGuestEligiblePaymentMethod(method))
}

/**
 * The payment method a checkout should DEFAULT to. Guests default to card (the
 * only method they can complete) so they never land on a method the API 401s;
 * authenticated customers keep the PIX default.
 */
export function defaultPaymentMethod(isAuthenticated: boolean): CheckoutPaymentMethod {
  return isAuthenticated ? 'pix' : 'card'
}

/**
 * True when the current selection needs the customer to sign in first — a guest
 * holding a PIX / cash selection. Drives the inline "entrar" prompt and blocks
 * submit so the guest never fires a request the API would 401.
 */
export function guestNeedsLogin(
  isAuthenticated: boolean,
  method: CheckoutPaymentMethod,
): boolean {
  return !isAuthenticated && !isGuestEligiblePaymentMethod(method)
}
