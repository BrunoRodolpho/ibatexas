/**
 * @ibatexas/pack-payments — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`). Default polarity is REFUSE — per master
 * plan §"Governance principles" #4 and
 * `governance/04-decision-policy.md` §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. Kernel evaluation order is
 * `state → taint → auth → business` (ADR-104). The refund-magnitude
 * ladder lives in the business phase so the structural REFUSE/CONFIRM/
 * ESCALATE bands fire after state preconditions (exists, terminal)
 * already passed.
 *
 * # Migrated from `paymentProjectionPolicyBundle`
 *
 * The W3 fixes ground-truthed five payment kinds inside
 * `packages/domain/src/services/__shared__/payment-projection-policy.ts`.
 * This Pack carries the same guards (`refundMagnitudeGuard`,
 * `regenerationCountCapGuard`, `requirePaymentExists`,
 * `refuseTerminalTransition`) PLUS the additional 12 kinds the
 * taxonomy enumerates. The legacy bundle becomes a re-export shim
 * (Decision D8 — parallel-surface during incremental migration).
 */

import {
  basis,
  BASIS_CODES,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import {
  refundStateDivergent,
  refuseAmountNonPositive,
  refuseDefault,
  refuseMethodInvalid,
  refusePaymentNotFound,
  refusePaymentTerminal,
  refuseRefundAmountInvalid,
  refuseRefundOverBalance,
  refuseRegenerationCapExceeded,
  refuseRegenerationStateDivergent,
  refuseRetryCapExceeded,
  refuseSameMethodSwitch,
} from "./refusals.js"
import {
  getMaxPaymentRetriesPerDay,
  getMaxPixRegenerationsPerPayment,
  getRefundConfirmThresholdCentavos,
  getRefundEscalateThresholdCentavos,
  paymentsTaintPolicy,
  type PaymentChargeCreatePayload,
  type PaymentCreatePayload,
  type PaymentIntentKind,
  type PaymentMethodSwitchPayload,
  type PaymentPayload,
  type PaymentPixRegeneratePayload,
  type PaymentRefundIssuePayload,
  type PaymentRetryPayload,
  type PaymentState,
} from "./types.js"

type PaymentGuard = Guard<PaymentIntentKind, PaymentPayload, PaymentState>

// ── State guards ────────────────────────────────────────────────────────

/**
 * Most payment kinds require an existing Payment row. The exceptions
 * are creation kinds (`payment.create` / `payment.charge.create`) and
 * the method-switch kind (which can run BEFORE the new method's payment
 * row exists).
 */
const KINDS_REQUIRING_PAYMENT_EXISTS: ReadonlySet<PaymentIntentKind> = new Set([
  "payment.charge.confirm",
  "payment.charge.fail",
  "payment.charge.expire",
  "payment.charge.cancel",
  "payment.pix.regenerate",
  "payment.retry",
  "payment.refund.issue",
  "payment.refund.confirm",
  "payment.dispute.open",
  "payment.cash.confirm",
  "payment.waive",
  "payment.status.force",
  "payment.status.transition",
  "payment.status.reconcile",
])

const requirePaymentExists: PaymentGuard = (envelope, state) => {
  if (!KINDS_REQUIRING_PAYMENT_EXISTS.has(envelope.kind)) return null
  if (state.ctx.exists) return null
  return decisionRefuse(refusePaymentNotFound(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "payment_not_found",
      kind: envelope.kind,
    }),
  ])
}

/**
 * Block direct transitions on terminal payments — terminal rows must
 * not be resurrected. The webhook reconcile path already enforces this
 * imperatively, but the kernel adjudication adds a uniform audit-
 * visible basis for the refusal.
 *
 * Applies to `payment.status.transition`, `payment.refund.issue`,
 * `payment.status.force`. `payment.status.reconcile` is exempt
 * (out-of-order Stripe events legitimately arrive after terminal).
 */
const KINDS_BLOCKED_ON_TERMINAL: ReadonlySet<PaymentIntentKind> = new Set([
  "payment.status.transition",
  "payment.refund.issue",
  "payment.status.force",
])

const refuseTerminalTransition: PaymentGuard = (envelope, state) => {
  if (!KINDS_BLOCKED_ON_TERMINAL.has(envelope.kind)) return null
  if (!state.ctx.isTerminal) return null
  return decisionRefuse(refusePaymentTerminal(state.ctx.currentStatus), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "payment_terminal",
      currentStatus: state.ctx.currentStatus,
    }),
  ])
}

// ── Business guards ─────────────────────────────────────────────────────

const VALID_METHODS = new Set(["pix", "card", "cash"])

const validateCreateMethod: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.create" && envelope.kind !== "payment.charge.create") {
    return null
  }
  const payload = envelope.payload as PaymentCreatePayload | PaymentChargeCreatePayload
  if (typeof payload.method !== "string" || !VALID_METHODS.has(payload.method)) {
    return decisionRefuse(refuseMethodInvalid(payload.method), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "method_valid",
        seen: payload.method,
      }),
    ])
  }
  if (
    typeof payload.amountInCentavos !== "number" ||
    !Number.isInteger(payload.amountInCentavos) ||
    payload.amountInCentavos <= 0
  ) {
    return decisionRefuse(refuseAmountNonPositive(payload.amountInCentavos), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "amount_positive_integer",
        seen: payload.amountInCentavos,
      }),
    ])
  }
  return null
}

const validateMethodSwitch: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.method.switch") return null
  const payload = envelope.payload as PaymentMethodSwitchPayload
  if (
    typeof payload.toMethod !== "string" ||
    !VALID_METHODS.has(payload.toMethod) ||
    typeof payload.fromMethod !== "string" ||
    !VALID_METHODS.has(payload.fromMethod)
  ) {
    return decisionRefuse(refuseMethodInvalid(payload.toMethod), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "method_valid",
        from: payload.fromMethod,
        to: payload.toMethod,
      }),
    ])
  }
  if (payload.fromMethod === payload.toMethod) {
    return decisionRefuse(refuseSameMethodSwitch(payload.toMethod), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "method_switch_no_change",
        method: payload.toMethod,
      }),
    ])
  }
  return null
}

/**
 * W3 P0-1 — refund magnitude guard (migrated from
 * `paymentProjectionPolicyBundle`).
 *
 * Validates the refund amount and its relation to the refundable balance,
 * then emits the decision ladder per governance §"04-decision-policy.md":
 *
 *   - amount ≤ 0                                    → REFUSE (invalid)
 *   - amount > refundable balance                   → REFUSE (over-refund)
 *   - amount > ESCALATE_REFUND_THRESHOLD_CENTAVOS   → ESCALATE
 *   - amount > CONFIRM_REFUND_THRESHOLD_CENTAVOS    → REQUEST_CONFIRMATION
 *   - else                                          → EXECUTE
 *
 * The route layer's two-step receipt is a separate UX gate stacked on
 * top of this structural ladder.
 */
const refundMagnitudeGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.refund.issue") return null
  const payload = envelope.payload as PaymentRefundIssuePayload

  if (
    typeof payload.refundAmountCentavos !== "number" ||
    payload.refundAmountCentavos <= 0
  ) {
    return decisionRefuse(refuseRefundAmountInvalid(payload.refundAmountCentavos), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "refund_amount_non_positive",
        amount: payload.refundAmountCentavos,
      }),
    ])
  }

  // Cross-check the snapshot in the payload against the state. If they
  // diverge (concurrent partial refund), refuse so the operator
  // re-opens the route with a fresh snapshot.
  const stateRefunded = state.ctx.refundedAmountCentavos ?? 0
  if (
    typeof payload.currentRefundedCentavos === "number" &&
    payload.currentRefundedCentavos !== stateRefunded
  ) {
    return decisionRefuse(
      refundStateDivergent(payload.currentRefundedCentavos, stateRefunded),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "refund_state_divergent",
          envelope: payload.currentRefundedCentavos,
          state: stateRefunded,
        }),
      ],
    )
  }

  const refundable = payload.refundableBalanceCentavos
  if (
    typeof refundable === "number" &&
    payload.refundAmountCentavos > refundable
  ) {
    return decisionRefuse(
      refuseRefundOverBalance(payload.refundAmountCentavos, refundable),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "refund_over_balance",
          amount: payload.refundAmountCentavos,
          refundable,
        }),
      ],
    )
  }

  const escalateThreshold = getRefundEscalateThresholdCentavos()
  if (payload.refundAmountCentavos > escalateThreshold) {
    return decisionEscalate("human", "refund_above_escalate_threshold", [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "refund_above_escalate_threshold",
        amount: payload.refundAmountCentavos,
        escalateThreshold,
      }),
    ])
  }

  const confirmThreshold = getRefundConfirmThresholdCentavos()
  if (payload.refundAmountCentavos > confirmThreshold) {
    const reais = (payload.refundAmountCentavos / 100)
      .toFixed(2)
      .replace(".", ",")
    return decisionRequestConfirmation(
      `Confirmar reembolso de R$ ${reais}? Esta ação envia dinheiro de volta ao cliente.`,
      [
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          reason: "refund_within_confirm_band",
          amount: payload.refundAmountCentavos,
          confirmThreshold,
          escalateThreshold,
        }),
      ],
    )
  }

  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
      amount: payload.refundAmountCentavos,
    }),
  ])
}

/**
 * W3 P0-2 — PIX regeneration count cap guard (migrated from
 * `paymentProjectionPolicyBundle`).
 *
 * Refuses regenerations above `getMaxPixRegenerationsPerPayment()`. The
 * current count is read from the projection state (auth source) and
 * validated against the payload's `currentRegenerationCount` snapshot.
 */
const regenerationCountCapGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.pix.regenerate") return null
  const payload = envelope.payload as PaymentPixRegeneratePayload

  const stateCount = state.ctx.regenerationCount ?? 0
  if (
    typeof payload.currentRegenerationCount === "number" &&
    payload.currentRegenerationCount !== stateCount
  ) {
    return decisionRefuse(
      refuseRegenerationStateDivergent(
        payload.currentRegenerationCount,
        stateCount,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "regen_state_divergent",
          envelope: payload.currentRegenerationCount,
          state: stateCount,
        }),
      ],
    )
  }

  const cap = getMaxPixRegenerationsPerPayment()
  if (stateCount + 1 > cap) {
    return decisionRefuse(refuseRegenerationCapExceeded(stateCount, cap), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "regen_cap_exceeded",
        current: stateCount,
        cap,
      }),
    ])
  }

  return null
}

/**
 * Daily retry cap guard for `payment.retry`. Refuses retries above
 * `getMaxPaymentRetriesPerDay()` (default 3). The counter is projected
 * by the adopter from Redis (key `payment-retry:{customerId}:{YYYY-MM-DD}`).
 */
const retryDailyCapGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.retry") return null
  const payload = envelope.payload as PaymentRetryPayload
  void payload

  const cap = getMaxPaymentRetriesPerDay()
  const current = state.ctx.dailyRetryCount ?? 0
  if (current + 1 > cap) {
    return decisionRefuse(refuseRetryCapExceeded(current, cap), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        reason: "retry_cap_exceeded",
        current,
        cap,
      }),
    ])
  }
  return null
}

/**
 * `payment.dispute.open` always escalates — Stripe chargeback events
 * are too serious to auto-process. The route layer logs the dispute,
 * notifies ops, and freezes the order until a human resolves.
 */
const escalateAlwaysOnDispute: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.dispute.open") return null
  return decisionEscalate("human", "dispute_opened_requires_review", [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      reason: "dispute_opened",
      kind: envelope.kind,
    }),
  ])
}

/**
 * `payment.waive` always requests confirmation — irreversible debt
 * forgiveness must be intentional.
 */
const confirmAlwaysOnWaive: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.waive") return null
  return decisionRequestConfirmation(
    "Confirmar perdão de pagamento? Esta ação não pode ser desfeita.",
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "waive_requires_confirmation",
        kind: envelope.kind,
      }),
    ],
  )
}

/**
 * `payment.status.force` always requests confirmation — admin
 * override of state machine; should be intentional.
 */
const confirmAlwaysOnStatusForce: PaymentGuard = (envelope) => {
  if (envelope.kind !== "payment.status.force") return null
  return decisionRequestConfirmation(
    "Confirmar alteração manual de status do pagamento?",
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "status_force_requires_confirmation",
        kind: envelope.kind,
      }),
    ],
  )
}

// ── EXECUTE producers (default is REFUSE; positive matches required) ────

/**
 * Each happy-path kind needs an explicit EXECUTE guard because the
 * Pack's default is REFUSE.
 */
const executeAll: PaymentGuard = (envelope) => {
  switch (envelope.kind) {
    case "payment.create":
    case "payment.charge.create":
    case "payment.charge.confirm":
    case "payment.charge.fail":
    case "payment.charge.expire":
    case "payment.charge.cancel":
    case "payment.pix.regenerate":
    case "payment.method.switch":
    case "payment.retry":
    case "payment.refund.confirm":
    case "payment.cash.confirm":
    case "payment.status.transition":
    case "payment.status.reconcile":
      return decisionExecute([
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          kind: envelope.kind,
        }),
      ])
    default:
      return null
  }
}

// ── PolicyBundle ────────────────────────────────────────────────────────

/**
 * The payment-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel` to decide whether to execute a proposed
 * envelope. Default is REFUSE — any kind not covered by an explicit
 * EXECUTE guard is denied by construction.
 *
 * Phase order is fixed by the kernel: `state → taint → auth →
 * business → default`. Within each phase, guards run in declared
 * order; the FIRST non-null decision wins.
 *
 * # Guard ordering rationale
 *
 *   state:
 *     1. requirePaymentExists           — short-circuit if no projection
 *     2. refuseTerminalTransition       — block resurrecting terminal
 *
 *   auth: (none — auth is at the route layer)
 *
 *   taint: paymentsTaintPolicy (system-only kinds gated)
 *
 *   business:
 *     1. validateCreateMethod           — shape check create kinds
 *     2. validateMethodSwitch           — shape check switch kind
 *     3. refundMagnitudeGuard           — refund ladder (W3 P0-1)
 *     4. regenerationCountCapGuard      — PIX regen cap (W3 P0-2)
 *     5. retryDailyCapGuard             — retry rate limit
 *     6. escalateAlwaysOnDispute        — disputes always ESCALATE
 *     7. confirmAlwaysOnWaive           — waive always REQUEST_CONFIRMATION
 *     8. confirmAlwaysOnStatusForce     — force-status always confirm
 *     9. executeAll                     — EXECUTE producers
 */
export const paymentsPolicyBundle: PolicyBundle<
  PaymentIntentKind,
  PaymentPayload,
  PaymentState
> = {
  stateGuards: [requirePaymentExists, refuseTerminalTransition],
  authGuards: [],
  taint: paymentsTaintPolicy,
  business: [
    validateCreateMethod,
    validateMethodSwitch,
    refundMagnitudeGuard,
    regenerationCountCapGuard,
    retryDailyCapGuard,
    escalateAlwaysOnDispute,
    confirmAlwaysOnWaive,
    confirmAlwaysOnStatusForce,
    executeAll,
  ],
  /**
   * Fail-safe per master plan §"Governance principles" #4 — an intent
   * that no positive guard matched is REFUSEd.
   */
  default: "REFUSE",
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export { refuseDefault }
