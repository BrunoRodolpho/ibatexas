/**
 * Checkout domain logic.
 *
 * Centralises checkout validation, step management, and
 * order preparation — keeping page components thin.
 */

export type CheckoutStep = 'cart_review' | 'address' | 'shipping' | 'payment' | 'confirmation'

export const CHECKOUT_STEPS: CheckoutStep[] = [
  'cart_review',
  'address',
  'shipping',
  'payment',
  'confirmation',
]

/**
 * Get the next checkout step.
 */
export function nextStep(current: CheckoutStep): CheckoutStep | null {
  const idx = CHECKOUT_STEPS.indexOf(current)
  return idx < CHECKOUT_STEPS.length - 1 ? CHECKOUT_STEPS[idx + 1] : null
}

/**
 * Get the previous checkout step.
 */
export function prevStep(current: CheckoutStep): CheckoutStep | null {
  const idx = CHECKOUT_STEPS.indexOf(current)
  return idx > 0 ? CHECKOUT_STEPS[idx - 1] : null
}

// ── Step Validation (Strategy Pattern) ──────────────────────────────────

interface StepContext {
  itemCount: number
  hasAddress?: boolean
  hasShipping?: boolean
  hasPayment?: boolean
}

/**
 * Validation map — each step defines its own guard.
 * Adding a new step means adding one entry here.
 */
const STEP_VALIDATORS: Record<CheckoutStep, (ctx: StepContext) => boolean> = {
  cart_review:  (ctx) => ctx.itemCount > 0,
  address:      (ctx) => ctx.hasAddress === true,
  shipping:     (ctx) => ctx.hasShipping === true,
  payment:      (ctx) => ctx.hasPayment === true,
  confirmation: ()    => true,
}

/**
 * Validate that the minimum requirements for a step are met.
 */
export function canProceed(step: CheckoutStep, context: StepContext): boolean {
  return STEP_VALIDATORS[step](context)
}
