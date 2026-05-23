// payment-projection-policy.ts — domain-internal PolicyBundle for the
// PaymentCommandService chokepoint.
//
// Scope (intent kinds covered):
//   - payment.create                — SYSTEM. Initial Payment row for an
//                                     order. Single-active-payment per
//                                     order is enforced inside the
//                                     executor (the policy refuses on
//                                     `ActivePaymentExistsError` propagation,
//                                     not at the kernel layer).
//   - payment.status.transition     — SYSTEM/ADMIN. Direct status change
//                                     (e.g., admin force-confirm cash,
//                                     job marking pix_expired).
//   - payment.status.reconcile      — SYSTEM. Reconciliation from a
//                                     Stripe webhook event. Idempotency
//                                     + ownership + out-of-order checks
//                                     are inside the executor; the
//                                     kernel adjudication is a uniform
//                                     audit + provenance gate.
//   - payment.method.switch         — CUSTOMER. Switch payment method
//                                     (e.g., cash→pix). Out-of-scope
//                                     for this task's executor changes
//                                     but the intent kind is declared
//                                     so callers can adopt incrementally.
//
// Per investigation 03 P0 §"Payment state transitions ... kernel never
// validates the transition." This bundle is the kernel-validation entry
// point. Pack-payments-pix governs the PIX lifecycle separately — this
// is the project's local payment policy until a dedicated @ibatexas/
// pack-payments lands (Phase D of the master plan).

import {
  basis,
  BASIS_CODES,
  decisionExecute,
  decisionRefuse,
  refuse,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"

// ── Intent kinds + payloads ────────────────────────────────────────────────

export type PaymentProjectionIntentKind =
  | "payment.create"
  | "payment.status.transition"
  | "payment.status.reconcile"
  | "payment.method.switch"

export interface PaymentCreatePayload {
  readonly orderId: string
  readonly method: "pix" | "card" | "cash"
  /** Centavos integer per CLAUDE.md rule #2. */
  readonly amountInCentavos: number
  readonly stripePaymentIntentId?: string
  readonly pixExpiresAt?: string
  readonly idempotencyKey?: string
}

export interface PaymentStatusTransitionPayload {
  readonly paymentId: string
  readonly newStatus: string
  readonly actor: "admin" | "system" | "customer"
  readonly actorId?: string
  readonly reason?: string
  readonly expectedVersion?: number
}

export interface PaymentStatusReconcilePayload {
  readonly paymentId: string
  readonly newStatus: string
  readonly stripeEventId: string
  /** ISO-8601 string; the executor compares timestamps. */
  readonly stripeEventTimestamp?: string
  readonly expectedOrderId?: string
}

export interface PaymentMethodSwitchPayload {
  readonly orderId: string
  readonly fromMethod: "pix" | "card" | "cash"
  readonly toMethod: "pix" | "card" | "cash"
  readonly customerId: string
}

export type PaymentProjectionPayload =
  | PaymentCreatePayload
  | PaymentStatusTransitionPayload
  | PaymentStatusReconcilePayload
  | PaymentMethodSwitchPayload

// ── State ──────────────────────────────────────────────────────────────────

export interface PaymentProjectionState {
  readonly ctx: {
    /** Payment row exists (true for transition / reconcile, false for create). */
    readonly exists: boolean
    readonly currentStatus?: string
    readonly currentMethod?: "pix" | "card" | "cash"
    readonly version?: number
    /** Order id the payment belongs to — for ownership cross-checks. */
    readonly orderId?: string
    /** True when status is one of the terminal payment statuses. */
    readonly isTerminal?: boolean
  }
}

// ── Taint policy ───────────────────────────────────────────────────────────

/**
 * Most payment ops are SYSTEM-only — the LLM never authorizes a Stripe
 * reconcile or a status flip. Method-switch is the only customer-driven
 * intent, and even there the customer's authority is mediated through
 * the cart/amend tool layer.
 */
export const paymentProjectionTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [
    "payment.create",
    "payment.status.reconcile",
  ],
  userMinimum: "UNTRUSTED",
})

// ── Guards ─────────────────────────────────────────────────────────────────

type PaymentGuard = Guard<
  PaymentProjectionIntentKind,
  PaymentProjectionPayload,
  PaymentProjectionState
>

const requirePaymentExists: PaymentGuard = (envelope, state) => {
  if (
    envelope.kind === "payment.create" ||
    envelope.kind === "payment.method.switch"
  ) {
    return null
  }
  if (state.ctx.exists) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "payment.not_found",
      "Pagamento não encontrado.",
    ),
    [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "payment_not_found",
      }),
    ],
  )
}

/**
 * Block direct transitions on terminal payments — terminal rows must not
 * be resurrected. The webhook reconcile path already enforces this
 * imperatively, but the kernel adjudication adds a uniform audit-visible
 * basis for the refusal.
 */
const refuseTerminalTransition: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.status.transition") return null
  if (!state.ctx.isTerminal) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "payment.terminal_state",
      "Pagamento já está em estado final.",
    ),
    [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "payment_terminal",
        currentStatus: state.ctx.currentStatus,
      }),
    ],
  )
}

const executeAll: PaymentGuard = (envelope) => {
  switch (envelope.kind) {
    case "payment.create":
    case "payment.status.transition":
    case "payment.status.reconcile":
    case "payment.method.switch":
      return decisionExecute([
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          kind: envelope.kind,
        }),
      ])
    default:
      return null
  }
}

// ── PolicyBundle ──────────────────────────────────────────────────────────

export const paymentProjectionPolicyBundle: PolicyBundle<
  PaymentProjectionIntentKind,
  PaymentProjectionPayload,
  PaymentProjectionState
> = {
  stateGuards: [requirePaymentExists, refuseTerminalTransition],
  authGuards: [],
  taint: paymentProjectionTaintPolicy,
  business: [executeAll],
  default: "REFUSE",
}
