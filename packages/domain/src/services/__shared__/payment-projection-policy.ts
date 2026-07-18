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
  decisionEscalate,
  decisionRefuse,
  decisionRequestConfirmation,
  refuse,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"
import {
  classifyRefundMagnitudeBand,
  MONEY_BAND_1000_CENTAVOS,
} from "@ibatexas/types"

// ── Intent kinds + payloads ────────────────────────────────────────────────

export type PaymentProjectionIntentKind =
  | "payment.create"
  | "payment.status.transition"
  | "payment.status.reconcile"
  | "payment.method.switch"
  // W3 P0-1: refund magnitude carried in the envelope payload so the
  // kernel adjudicates the AMOUNT, not just the status transition.
  // Wave 5 will promote this to `@ibatexas/pack-payments`.
  | "payment.refund.issue"
  // W3 P0-2: PIX QR regeneration count increment — carried as a
  // separate envelope so the bump is kernel-visible. Wave 5 will fold
  // this into a composite `payment.pix.regenerate` kind.
  | "payment.regeneration.count.increment"
  // BKL-178: chargeback opened at Stripe — ADJUDICATE-ONLY, always
  // ESCALATEs for human review. Behavior-parity mirror of
  // `@ibatexas/pack-payments`' `escalateAlwaysOnDispute` (FE-D07 tracked
  // duplication); Wave 5 promotes this to the pack.
  | "payment.dispute.open"

/** Supported payment instruments (CLAUDE.md PIX-first). */
export type PaymentMethod = "pix" | "card" | "cash"

export interface PaymentCreatePayload {
  readonly orderId: string
  readonly method: PaymentMethod
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
  readonly fromMethod: PaymentMethod
  readonly toMethod: PaymentMethod
  readonly customerId: string
}

/**
 * W3 P0-1: refund magnitude is part of the envelope so the kernel
 * adjudicates the AMOUNT (not just status). Decision ladder (per
 * governance §"04-decision-policy.md", aligned with
 * `ESCALATE_REFUND_THRESHOLD_CENTAVOS = 100_000` in pack-payments-pix):
 *
 *   - amount ≤ R$500 (50_000 centavos)              → EXECUTE
 *   - R$500 < amount < R$1000 (100_000 centavos)    → REQUEST_CONFIRMATION
 *   - amount ≥ R$1000                               → ESCALATE (FE-T03/D2)
 *
 * The route layer's two-step receipt protocol gates above the R$200
 * `REFUND_CONFIRMATION_THRESHOLD_CENTAVOS` operator-experience
 * threshold separately; the kernel policy is the structural gate, the
 * route gate is the operator-UX gate. They overlap intentionally.
 */
export interface PaymentRefundIssuePayload {
  readonly paymentId: string
  /** Centavos integer per CLAUDE.md rule #2. */
  readonly refundAmountCentavos: number
  /** Refundable balance snapshot at envelope-build time (centavos). */
  readonly refundableBalanceCentavos: number
  /** Total amount of the original payment (centavos). */
  readonly amountInCentavos: number
  /** Existing refunded-amount sum (centavos). */
  readonly currentRefundedCentavos: number
  readonly actor: "admin" | "system"
  readonly actorId?: string
  readonly reason?: string
}

/**
 * W3 P0-2: PIX regeneration counter bump — system-actor envelope
 * issued by the regenerate-pix route after a successful create. Kernel
 * caps total regenerations per payment via the policy guard (default 5
 * per payment, configurable env override). Wave 5 will merge this with
 * `payment.pix.regenerate` as a composite kind.
 */
export interface PaymentRegenerationCountIncrementPayload {
  readonly paymentId: string
  /** Current value before increment — for optimistic concurrency. */
  readonly currentCount: number
}

/**
 * BKL-178: chargeback opened at Stripe (`charge.dispute.created`). A
 * system-actor envelope the webhook mints ALONGSIDE the DISPUTED reconcile.
 * Carries NO state mutation of its own — the domain guard
 * `escalateAlwaysOnDispute` ALWAYS ESCALATEs it for human review, and the
 * payment's DISPUTED status is written by `payment.status.reconcile` (status
 * truth). Behavior-parity with `@ibatexas/pack-payments`'
 * `PaymentDisputeOpenPayload`/`escalateAlwaysOnDispute` (FE-D07 tracked
 * duplication); Wave 5 promotes it to the pack.
 */
export interface PaymentDisputeOpenPayload {
  readonly paymentId: string
  readonly stripeEventId: string
  /** Chargeback amount in centavos (Stripe `dispute.amount`). */
  readonly disputeAmountCentavos?: number
}

export type PaymentProjectionPayload =
  | PaymentCreatePayload
  | PaymentStatusTransitionPayload
  | PaymentStatusReconcilePayload
  | PaymentMethodSwitchPayload
  | PaymentRefundIssuePayload
  | PaymentRegenerationCountIncrementPayload
  | PaymentDisputeOpenPayload

// ── State ──────────────────────────────────────────────────────────────────

export interface PaymentProjectionState {
  readonly ctx: {
    /** Payment row exists (true for transition / reconcile, false for create). */
    readonly exists: boolean
    readonly currentStatus?: string
    readonly currentMethod?: PaymentMethod
    readonly version?: number
    /** Order id the payment belongs to — for ownership cross-checks. */
    readonly orderId?: string
    /** True when status is one of the terminal payment statuses. */
    readonly isTerminal?: boolean
    /** Centavos — current `refundedAmountCentavos` for the payment. */
    readonly refundedAmountCentavos?: number
    /** Centavos — original `amountInCentavos` for the payment. */
    readonly amountInCentavos?: number
    /** PIX regeneration counter snapshot (W3 P0-2). */
    readonly regenerationCount?: number
  }
}

// ── Refund magnitude thresholds (centavos — CLAUDE.md rule #2) ────────────

/**
 * W3 P0-1 — refund magnitude decision ladder. Matches governance
 * §"04-decision-policy.md" and pack-payments-pix's
 * `ESCALATE_REFUND_THRESHOLD_CENTAVOS = 100_000`.
 *
 * EXECUTE at or below CONFIRM threshold; REQUEST_CONFIRMATION between
 * CONFIRM and ESCALATE; ESCALATE at-or-above the escalate ceiling
 * (FE-T03/D2 — comparator flipped from strict `>` to `>=`, matching
 * `@ibatexas/pack-payments`' refund-escalate ladder for behavior-parity
 * between the admin-HTTP path (this bundle) and the ops/WhatsApp path).
 *
 * Env overrides (set in `.env` or process env):
 *   REFUND_CONFIRM_THRESHOLD_CENTAVOS  — default 50_000 (R$500)
 *   REFUND_ESCALATE_THRESHOLD_CENTAVOS — default 100_000 (R$1000)
 */
function readEnvCentavos(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 0) return fallback
  return n
}

export function getRefundConfirmThresholdCentavos(): number {
  return readEnvCentavos("REFUND_CONFIRM_THRESHOLD_CENTAVOS", 50_000)
}

export function getRefundEscalateThresholdCentavos(): number {
  // FE-D07: fallback single-sourced from `@ibatexas/types`'
  // `MONEY_BAND_1000_CENTAVOS` (=== 100_000), the same value the
  // `@ibatexas/pack-payments` getter reads, so the escalate boundary can't
  // drift by channel. Env override still wins when set.
  return readEnvCentavos(
    "REFUND_ESCALATE_THRESHOLD_CENTAVOS",
    MONEY_BAND_1000_CENTAVOS,
  )
}

/**
 * W3 P0-2 — per-payment regeneration cap. Default 5 attempts; env
 * override `MAX_PIX_REGENERATIONS_PER_PAYMENT`.
 */
export function getMaxPixRegenerationsPerPayment(): number {
  const raw = process.env["MAX_PIX_REGENERATIONS_PER_PAYMENT"]
  if (!raw) return 5
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 1) return 5
  return n
}

// ── Taint policy ───────────────────────────────────────────────────────────

/**
 * Most payment ops are SYSTEM-only — the LLM never authorizes a Stripe
 * reconcile or a status flip. Method-switch is the only customer-driven
 * intent, and even there the customer's authority is mediated through
 * the cart/amend tool layer.
 *
 * `payment.refund.issue` is staff-driven (admin route). Taint TRUSTED
 * is required; the route layer attaches `actor.principal = "user"` and
 * `taint = "TRUSTED"` after `requireManagerRole` succeeds (or SYSTEM
 * for the API-key path).
 *
 * `payment.regeneration.count.increment` is SYSTEM-only — the bump is
 * issued by the route after a successful regenerate-pix flow.
 */
export const paymentProjectionTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [
    "payment.create",
    "payment.status.reconcile",
    "payment.regeneration.count.increment",
    // BKL-178 — dispute.open is minted only by the Stripe webhook (SYSTEM).
    "payment.dispute.open",
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
 *
 * W3 P0-1: also refuse `payment.refund.issue` on a terminal payment —
 * a `refunded` payment cannot be refunded again, and the executor's
 * defensive throw becomes a kernel REFUSE instead.
 */
const refuseTerminalTransition: PaymentGuard = (envelope, state) => {
  if (
    envelope.kind !== "payment.status.transition" &&
    envelope.kind !== "payment.refund.issue"
  ) {
    return null
  }
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

/**
 * W3 P0-1 — refund magnitude guard.
 *
 * Validates the refund amount and its relation to the refundable balance,
 * then emits the decision ladder per governance §"04-decision-policy.md":
 *
 *   - amount ≤ 0                                    → REFUSE (invalid)
 *   - amount > refundable balance                   → REFUSE (over-refund)
 *   - amount ≥ ESCALATE_REFUND_THRESHOLD_CENTAVOS   → ESCALATE (FE-T03/D2)
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
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "refund.amount_invalid",
        "Valor de reembolso inválido.",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "refund_amount_non_positive",
          amount: payload.refundAmountCentavos,
        }),
      ],
    )
  }

  // Cross-check the snapshot in the payload against the state — the
  // route layer's payload should mirror what we observe in the projection.
  // If they diverge (concurrent partial refund), refuse so the operator
  // re-opens the route with a fresh snapshot.
  const stateRefunded = state.ctx.refundedAmountCentavos ?? 0
  if (
    typeof payload.currentRefundedCentavos === "number" &&
    payload.currentRefundedCentavos !== stateRefunded
  ) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "refund.state_divergent",
        "Estado de reembolso divergente. Reabra a operação.",
      ),
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
      refuse(
        "BUSINESS_RULE",
        "refund.amount_invalid",
        "Esse valor de reembolso é maior do que o disponível.",
      ),
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
  const confirmThreshold = getRefundConfirmThresholdCentavos()
  // FE-D07: the EXECUTE / CONFIRM / ESCALATE band mapping is single-sourced
  // in `@ibatexas/types.classifyRefundMagnitudeBand`, shared byte-for-byte
  // with the ops/WhatsApp `@ibatexas/pack-payments` bundle so this admin-HTTP
  // route can never fork the money bands. FE-T03/D2 lives inside the helper:
  // escalate uses `>=`, so an exact R$1000 refund ESCALATEs identically on
  // both channels (pinned by apps/api's refund-band-channel-parity.test.ts).
  const band = classifyRefundMagnitudeBand(
    payload.refundAmountCentavos,
    confirmThreshold,
    escalateThreshold,
  )
  if (band === "ESCALATE") {
    return decisionEscalate(
      "human",
      "refund_above_escalate_threshold",
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "refund_above_escalate_threshold",
          amount: payload.refundAmountCentavos,
          escalateThreshold,
        }),
      ],
    )
  }

  if (band === "CONFIRM") {
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
 * W3 P0-2 — regeneration count cap guard.
 *
 * Refuses bumps above `getMaxPixRegenerationsPerPayment()`. The current
 * count is read from the projection state (auth source) and validated
 * against the payload's `currentCount` snapshot.
 */
const regenerationCountCapGuard: PaymentGuard = (envelope, state) => {
  if (envelope.kind !== "payment.regeneration.count.increment") return null
  const payload = envelope.payload as PaymentRegenerationCountIncrementPayload

  const stateCount = state.ctx.regenerationCount ?? 0
  if (
    typeof payload.currentCount === "number" &&
    payload.currentCount !== stateCount
  ) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "regeneration.state_divergent",
        "Estado de regeneração divergente. Reabra a operação.",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "regen_state_divergent",
          envelope: payload.currentCount,
          state: stateCount,
        }),
      ],
    )
  }

  const cap = getMaxPixRegenerationsPerPayment()
  if (stateCount + 1 > cap) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "regeneration.cap_exceeded",
        "Limite de regenerações para este pagamento atingido.",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "regen_cap_exceeded",
          current: stateCount,
          cap,
        }),
      ],
    )
  }

  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
      newCount: stateCount + 1,
      cap,
    }),
  ])
}

/**
 * BKL-178 — chargebacks ALWAYS ESCALATE. A `charge.dispute.created` from
 * Stripe is too serious to auto-process: the payment is reconciled to
 * DISPUTED (status truth, a separate `payment.status.reconcile` envelope)
 * and this guard routes the dispute itself to human review. Behavior-parity
 * mirror of `@ibatexas/pack-payments`' `escalateAlwaysOnDispute` (FE-D07
 * tracked duplication) — reads no state, so it fires uniformly.
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

// ── PolicyBundle ──────────────────────────────────────────────────────────

export const paymentProjectionPolicyBundle: PolicyBundle<
  PaymentProjectionIntentKind,
  PaymentProjectionPayload,
  PaymentProjectionState
> = {
  stateGuards: [requirePaymentExists, refuseTerminalTransition],
  authGuards: [],
  taint: paymentProjectionTaintPolicy,
  business: [
    escalateAlwaysOnDispute,
    refundMagnitudeGuard,
    regenerationCountCapGuard,
    executeAll,
  ],
  default: "REFUSE",
}
