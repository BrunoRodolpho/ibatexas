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

// ── Field Validators ────────────────────────────────────────────────────
// Pure rules for the checkout form fields. Shared by the inline per-field
// validation feedback and the submit-button gating so the two never drift.

/**
 * Brazilian CPF validation (format + both check digits).
 * Accepts a value with or without the `.`/`-` mask.
 */
export function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, "")
  if (digits.length !== 11) return false
  if (/^(\d)\1+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i)
  let check = 11 - (sum % 11)
  if (check >= 10) check = 0
  if (check !== Number(digits[9])) return false
  sum = 0
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i)
  check = 11 - (sum % 11)
  if (check >= 10) check = 0
  return check === Number(digits[10])
}

/** A PIX payer name must have at least two words (first + last name). */
export function isValidPixName(value: string): boolean {
  return value.trim().split(/\s+/).filter(Boolean).length >= 2
}

/** Basic email shape check. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
