/**
 * @ibatexas/pack-payments — first-party Pack for the payment domain.
 *
 * Fifth first-party Pack after orders / reservations / whatsapp /
 * customer-onboarding. Adds policy coverage for the full payment
 * lifecycle: charge create/confirm/fail/expire/cancel, PIX regenerate,
 * refund issue/confirm, method switch, retry, dispute, cash confirm,
 * waive, status force/transition/reconcile. Follows the
 * `pack-customer-onboarding` template per CLAUDE.md rule #9 / ADR #13.
 *
 * # Adoption patterns
 *
 *   1. Canonical-Pack-intent (recommended): import `paymentsPack`,
 *      dispatch envelopes against `paymentsPack.policy`. The Pack's
 *      intent kinds (`payment.refund.issue`, `payment.pix.regenerate`,
 *      `payment.cash.confirm`, …) are the wire contract; the master
 *      taxonomy at `docs/adjudicate-migration/governance/
 *      01-intent-taxonomy.md` §"Domain: payment" is authoritative.
 *
 *   2. Bundle-only: import `paymentsPolicyBundle` and feed to
 *      `adjudicate()` directly. The legacy
 *      `paymentProjectionPolicyBundle` from
 *      `packages/domain/src/services/__shared__/payment-projection-policy.ts`
 *      now re-exports a subset of this Pack's bundle for backwards
 *      compatibility (Decision D8 — parallel-surface during incremental
 *      caller migration).
 *
 * # Conformance
 *
 * `paymentsPack satisfies PackV0<...>`. The
 * `__tests__/conformance.test.ts` corpus pins behaviour;
 * `runConformance(paymentsPack)` from `@adjudicate/conformance` runs
 * the kernel-level invariant suite (taint protection, replay
 * determinism, basis-vocabulary purity, guard ordering, default
 * polarity).
 */

import type { PackV0 } from "@adjudicate/core"
import { paymentsCapabilityPlanner } from "./capabilities.js"
import { paymentsPolicyBundle } from "./policies.js"
import type {
  PaymentContext,
  PaymentIntentKind,
  PaymentPayload,
  PaymentState,
} from "./types.js"

// ── Rehydrator ──────────────────────────────────────────────────────────

/**
 * Reconstitute a `PaymentState` from a JSON-serializable representation.
 *
 * The state shape is plain-object (no `Date` / `Map` / `Set` fields), so
 * the rehydrator is a near-passthrough — its presence documents intent
 * ("this is the deserialization boundary") rather than doing
 * transformation. Permissive on input per the `PackV0.rehydrateState`
 * convention: malformed/missing fields fall back to empty defaults so
 * scenario fixtures and audit-replay payloads can be lenient while
 * the policy's guards remain the authoritative validators.
 */
export function rehydratePaymentState(raw: unknown): PaymentState {
  const defaultState: PaymentState = {
    ctx: {
      actor: { principal: "system" },
      exists: false,
    },
  }
  if (typeof raw !== "object" || raw === null || !("ctx" in raw)) {
    return defaultState
  }
  const ctxRaw = (raw as { ctx: unknown }).ctx
  if (typeof ctxRaw !== "object" || ctxRaw === null) {
    return defaultState
  }
  return raw as PaymentState
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export {
  getMaxPaymentRetriesPerDay,
  getMaxPixRegenerationsPerPayment,
  getRefundConfirmThresholdCentavos,
  getRefundEscalateThresholdCentavos,
  paymentsTaintPolicy,
  type PaymentChargeCancelPayload,
  type PaymentChargeConfirmPayload,
  type PaymentChargeCreatePayload,
  type PaymentChargeExpirePayload,
  type PaymentChargeFailPayload,
  type PaymentContext,
  type PaymentCashConfirmPayload,
  type PaymentCreatePayload,
  type PaymentDisputeOpenPayload,
  type PaymentIntentKind,
  type PaymentMethodSwitchPayload,
  type PaymentPayload,
  type PaymentPixRegeneratePayload,
  type PaymentRefundConfirmPayload,
  type PaymentRefundIssuePayload,
  type PaymentRetryPayload,
  type PaymentState,
  type PaymentStatusForcePayload,
  type PaymentStatusReconcilePayload,
  type PaymentStatusTransitionPayload,
  type PaymentWaivePayload,
} from "./types.js"

export {
  PIX_CONFIRMATION_SIGNAL,
  type PaymentsSignal,
} from "./signals.js"

export {
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
  portugueseRefusalMessages,
} from "./refusals.js"

export { paymentsPolicyBundle } from "./policies.js"

export {
  PAYMENT_TOOL_TO_INTENT,
  PAYMENT_TOOLS,
  paymentsCapabilityPlanner,
} from "./capabilities.js"

/**
 * The Pack as a `PackV0`-conformant value. The `satisfies` clause
 * provides compile-time conformance — drift from `PackV0`'s shape
 * fails the build. `intents` stays narrowly typed via the explicit
 * type parameters; the master taxonomy (governance §"Domain: payment")
 * is the source of truth.
 *
 * Pack id convention matches sibling Packs (`ibatexas/pack-orders`,
 * etc.): short, no scope prefix on the `id` field itself; the npm
 * scope lives in `package.json` only.
 */
export const paymentsPack = {
  id: "ibatexas/pack-payments",
  version: "1.0.0",
  contract: "v0",
  intents: [
    "payment.create",
    "payment.charge.create",
    "payment.charge.confirm",
    "payment.charge.fail",
    "payment.charge.expire",
    "payment.charge.cancel",
    "payment.pix.regenerate",
    "payment.method.switch",
    "payment.retry",
    "payment.refund.issue",
    "payment.refund.confirm",
    "payment.dispute.open",
    "payment.cash.confirm",
    "payment.waive",
    "payment.status.force",
    "payment.status.transition",
    "payment.status.reconcile",
  ],
  policy: paymentsPolicyBundle,
  planner: paymentsCapabilityPlanner,
  /**
   * Refusal codes the Pack's policy may emit. The M3 AaC drift check
   * (`assertPackConformance` + `withBasisAudit`) verifies that
   * runtime emissions stay inside this set; new code added in
   * `refusals.ts` MUST be added here too.
   */
  basisCodes: [
    "payment.not_found",
    "payment.terminal_state",
    "payment.amount_invalid",
    "payment.method.invalid",
    "payment.method.same",
    "payment.default.deny",
    "refund.amount_invalid",
    "refund.state_divergent",
    "regeneration.state_divergent",
    "regeneration.cap_exceeded",
    "retry.cap_exceeded",
  ],
  /**
   * DEFER signal vocabulary. Pack-payments today does not DEFER on its
   * own kinds — the `order.checkout.create` DEFER is composed inside
   * pack-orders via `@adjudicate/pack-payments-pix`. Empty list to
   * satisfy `PackV0` while preserving the extension point.
   */
  signals: [],
  rehydrateState: rehydratePaymentState,
} as const satisfies PackV0<
  PaymentIntentKind,
  PaymentPayload,
  PaymentState,
  PaymentContext
>
