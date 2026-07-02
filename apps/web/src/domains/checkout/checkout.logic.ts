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

/** Minimal cart-item shape needed to render per-item instructions (CUS-015). */
export interface CheckoutInstructionItem {
  title: string
  quantity: number
  variantTitle?: string
  specialInstructions?: string
}

/** The checkout body `notes` field is capped at 500 chars server-side. */
export const CHECKOUT_NOTES_MAX = 500

/** Result of merging per-item instructions into the order-level notes. */
export interface MergedNotes {
  /** The full merged content — never truncated. */
  notes: string
  /** true when `notes` exceeds {@link CHECKOUT_NOTES_MAX}; the caller must block submit. */
  overflow: boolean
}

/**
 * Merge per-item special instructions into the order-level notes (CUS-015).
 *
 * Per-item instructions have no native line-item channel to the kitchen; the
 * order-level OrderNote is the one working path (rendered in admin). So each
 * item carrying a non-empty instruction becomes a line
 * `"N× Title — Variant: instruction"`, appended after the customer's own note.
 *
 * NEVER truncates: a silently dropped line could be an allergy note. When the
 * merged content exceeds {@link CHECKOUT_NOTES_MAX} (the server-side cap),
 * `overflow` is true and the caller must block submit until the customer
 * shortens the text. `notes` is '' when there is nothing to send.
 */
export function mergeItemInstructionsIntoNotes(
  baseNotes: string,
  items: readonly CheckoutInstructionItem[],
): MergedNotes {
  const lines: string[] = []
  const base = baseNotes.trim()
  if (base) lines.push(base)
  for (const item of items) {
    const instr = item.specialInstructions?.trim()
    if (!instr) continue
    const variant = item.variantTitle ? ` — ${item.variantTitle}` : ''
    lines.push(`${item.quantity}× ${item.title}${variant}: ${instr}`)
  }
  const notes = lines.join('\n')
  return { notes, overflow: notes.length > CHECKOUT_NOTES_MAX }
}
