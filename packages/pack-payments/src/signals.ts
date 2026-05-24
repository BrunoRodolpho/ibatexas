/**
 * @ibatexas/pack-payments — DEFER signal vocabulary.
 *
 * Pack-payments today does not DEFER on its own intents — PIX pending
 * DEFER lives on `order.checkout.create` via
 * `@adjudicate/pack-payments-pix`'s `createPixPendingDeferGuard`. This
 * module exposes the constant for symmetry with sibling Packs so any
 * future DEFER guard introduced inside pack-payments has a single
 * documented surface to extend.
 *
 * Mirrors the pattern from `@ibatexas/pack-customer-onboarding`
 * (`customer.anonymize.confirmed_after_grace`).
 */

/**
 * The Pack re-exports the canonical PIX-confirmation signal from
 * `@adjudicate/pack-payments-pix`. Adopter subscribers can import the
 * constant from either pack — they refer to the same wire string.
 */
export { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix"

/**
 * Union of every DEFER signal this Pack may emit. Empty today —
 * extension point for future DEFER guards inside pack-payments
 * (e.g., chargeback-resolution-grace).
 */
export type PaymentsSignal = never
