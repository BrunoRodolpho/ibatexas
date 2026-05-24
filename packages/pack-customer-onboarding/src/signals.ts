/**
 * @ibatexas/pack-customer-onboarding — DEFER signal vocabulary.
 *
 * The Pack parks `customer.anonymize` on
 * `customer.anonymize.confirmed_after_grace` — the 24h LGPD Art. 18 grace
 * window. Task 14 ships the HTTP routes that consume the DEFER (parking
 * the receipt in Redis under `rk('anonymize:pending:{customerId}')`) and
 * the grace resolver that fires the signal once the window elapses
 * without a `customer.anonymize.cancel`.
 *
 * Mirrors the pattern from
 * `@adjudicate/pack-payments-pix` (`payment.confirmed`) and
 * `@ibatexas/pack-reservations` (`slot.released`): each Pack exports its
 * signal vocabulary from a dedicated `./signals` subpath so adopters can
 * import the constant without dragging in the full Pack bundle (e.g.,
 * for a subscriber that only needs to assert the signal name when
 * dispatching `intent_decision.resolved`).
 */

/**
 * Wire signal the kernel parks `customer.anonymize` on. Fired by the
 * grace-period resolver (task 14) once 24h (configurable via
 * `CUSTOMER_ANONYMIZE_GRACE_HOURS`) have elapsed without a corresponding
 * `customer.anonymize.cancel` clearing the receipt.
 *
 * Per `governance/04-decision-policy.md` §"DEFER semantics" and
 * investigation 08 P0 #2 (LGPD anonymize gap).
 */
export const CUSTOMER_ANONYMIZE_GRACE_SIGNAL =
  "customer.anonymize.confirmed_after_grace" as const

/**
 * Union of every DEFER signal this Pack may emit. Adopters writing a
 * subscriber that fans out resolver events can pattern-match against
 * this union for exhaustiveness.
 */
export type CustomerOnboardingSignal = typeof CUSTOMER_ANONYMIZE_GRACE_SIGNAL
