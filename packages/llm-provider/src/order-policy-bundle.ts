// Order-domain PolicyBundle — IbateXas adopter glue against the
// @adjudicate/* framework.
//
// Lives in @ibatexas/llm-provider as the canonical example of how an
// adopter authors a PolicyBundle against the framework's contracts.
// When this code eventually ships as a published commerce-reference,
// it moves into that example package; the export shape stays stable so
// the responder's import doesn't churn.
//
// PIX-pending DEFER semantics live in @adjudicate/pack-payments-pix
// (Phase 1 lighthouse Pack). The factory `createPixPendingDeferGuard`
// is composed below so the Pack owns the contract; this file owns
// only the IbateXas-specific intent kind that triggers it.

import {
  basis,
  BASIS_CODES,
  decisionRefuse,
  type IntentEnvelope,
  type TaintPolicy,
} from "@adjudicate/core"
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel"
import { createPixPendingDeferGuard } from "@adjudicate/pack-payments-pix"
import {
  refuseCartEmpty,
  refuseGuestCheckoutBlocked,
  refuseNoOrderToMutate,
  refuseNotAuthenticated,
  refuseOrderAlreadyCancelled,
  refuseOrderAlreadyShipped,
  refuseSlotsIncomplete,
} from "./refusal-taxonomy.js"
import {
  canAmendOrder,
  canCancelOrder,
  canCheckout,
  hasCartItems,
  hasOrderId,
  isAuthenticated,
  allSlotsFilled,
} from "./machine/guards.js"
import type { OrderContext } from "./machine/types.js"

// ── Intent kind → minimum taint required ────────────────────────────────────

const INTENT_TAINT_REQUIREMENTS: Record<
  string,
  "SYSTEM" | "TRUSTED" | "UNTRUSTED"
> = {
  // Payment is the most sensitive — must originate from a TRUSTED actor.
  "payment.send": "TRUSTED",
  "refund.issue": "TRUSTED",
  // Order mutations proposed by the LLM are inherently UNTRUSTED at this
  // stage; the guards below enforce the state-machine legality gate.
  "order.tool.propose": "UNTRUSTED",
  "order.submit": "UNTRUSTED",
  "order.cancel": "UNTRUSTED",
  "order.amend": "UNTRUSTED",
  "order.confirm": "UNTRUSTED",
}

export const orderTaintPolicy: TaintPolicy = {
  minimumFor(kind) {
    return INTENT_TAINT_REQUIREMENTS[kind] ?? "UNTRUSTED"
  },
}

// ── State / context shape consumed by the guards ────────────────────────────

export interface OrderState {
  readonly ctx: OrderContext
}

export type OrderEnvelope = IntentEnvelope<string, unknown>

// ── Auth guards ────────────────────────────────────────────────────────────

const requireAuthenticated: Guard<string, unknown, OrderState> = (
  _envelope,
  state,
) => {
  if (isAuthenticated(state.ctx)) return null
  return decisionRefuse(refuseNotAuthenticated(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_MISSING),
  ])
}

const requireCheckoutEligibility: Guard<string, unknown, OrderState> = (
  envelope,
  state,
) => {
  if (
    !envelope.kind.startsWith("order.submit") &&
    envelope.kind !== "checkout.commit"
  ) {
    return null
  }
  if (canCheckout(state.ctx)) return null
  return decisionRefuse(refuseGuestCheckoutBlocked(), [
    basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT),
  ])
}

// ── State guards ───────────────────────────────────────────────────────────

const requireCartItems: Guard<string, unknown, OrderState> = (
  envelope,
  state,
) => {
  if (
    !envelope.kind.startsWith("order.submit") &&
    envelope.kind !== "checkout.commit"
  ) {
    return null
  }
  if (hasCartItems(state.ctx)) return null
  return decisionRefuse(refuseCartEmpty(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, { reason: "cart_empty" }),
  ])
}

const requireCancellable: Guard<string, unknown, OrderState> = (
  envelope,
  state,
) => {
  if (envelope.kind !== "order.cancel") return null
  if (!hasOrderId(state.ctx)) {
    return decisionRefuse(refuseNoOrderToMutate(), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, { reason: "no_order" }),
    ])
  }
  if (!canCancelOrder(state.ctx)) {
    return decisionRefuse(refuseOrderAlreadyCancelled(), [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "already_cancelled",
      }),
    ])
  }
  return null
}

const requireAmendable: Guard<string, unknown, OrderState> = (
  envelope,
  state,
) => {
  if (envelope.kind !== "order.amend") return null
  if (!canAmendOrder(state.ctx)) {
    return decisionRefuse(refuseOrderAlreadyShipped(), [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "already_shipped",
      }),
    ])
  }
  return null
}

const requireSlotsFilled: Guard<string, unknown, OrderState> = (
  envelope,
  state,
) => {
  if (
    envelope.kind !== "order.submit" &&
    envelope.kind !== "checkout.commit"
  ) {
    return null
  }
  if (allSlotsFilled(state.ctx)) return null
  return decisionRefuse(refuseSlotsIncomplete(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "slots_incomplete",
    }),
  ])
}

// ── DEFER producer (delegated to @adjudicate/pack-payments-pix) ────────────

// The PIX-pending DEFER guard is owned by the Pack. The factory below
// adapts it to IbateXas's intent kind (`order.confirm`) and the
// OrderContext shape. The wire signal (`payment.confirmed`), 15-minute
// timeout, and confirmed-statuses set ({paid, captured, confirmed,
// pix's own internal labels}) come from the Pack so consumers cannot
// silently diverge from Pack semantics.
const deferOnPendingPix: Guard<string, unknown, OrderState> =
  createPixPendingDeferGuard<OrderState>({
    readPaymentMethod: (state) =>
      (state.ctx as { paymentMethod?: string | null }).paymentMethod ?? null,
    readPaymentStatus: (state) =>
      (state.ctx as { paymentStatus?: string | null }).paymentStatus ?? null,
    matchesIntent: (kind) => kind === "order.confirm",
    confirmedStatuses: new Set(["paid", "captured", "confirmed"]),
  })

// ── PolicyBundle ───────────────────────────────────────────────────────────

/**
 * The IbateXas order-domain PolicyBundle. Feed to `adjudicate()` when deciding
 * whether to execute a proposed intent. Default is REFUSE — any intent not
 * covered by an explicit guard is denied by construction.
 */
export const orderPolicyBundle: PolicyBundle<string, unknown, OrderState> = {
  stateGuards: [
    requireCartItems,
    requireCancellable,
    requireAmendable,
    requireSlotsFilled,
    deferOnPendingPix,
  ],
  authGuards: [requireAuthenticated, requireCheckoutEligibility],
  taint: orderTaintPolicy,
  business: [],
  default: "REFUSE",
}
