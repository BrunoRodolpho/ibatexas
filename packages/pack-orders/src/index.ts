/**
 * @ibatexas/pack-orders — first-party Pack for the order / checkout domain.
 *
 * Lighthouse first-party Pack. Migrates `packages/llm-provider/src/
 * order-policy-bundle.ts` into a workspace package following the
 * `@adjudicate/pack-payments-pix` layout (CLAUDE.md rule #9 ADR #13).
 *
 * Two adoption patterns:
 *
 *   1. Canonical-Pack-intent (recommended): import `ordersPack`, dispatch
 *      envelopes against `ordersPack.policy`. The Pack's intent kinds
 *      (`order.cart.ensure`, `order.item.add`, `order.checkout.create`, …)
 *      are the wire contract; the master taxonomy at
 *      `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
 *      §"Domain: order" is authoritative.
 *
 *   2. Bundle-only: import `ordersPolicyBundle` and feed to `adjudicate()`
 *      directly. The legacy `packages/llm-provider/src/order-policy-bundle.ts`
 *      now re-exports this binding under its old name for backwards
 *      compatibility (deprecated).
 *
 * Conformance: `ordersPack satisfies PackV0<...>`. The
 * `__tests__/conformance.test.ts` corpus pins behaviour to the legacy
 * `orderPolicyBundle` decisions; `runConformance(ordersPack)` from
 * `@adjudicate/conformance` runs the kernel-level invariant suite
 * (taint protection, replay determinism, basis-vocabulary purity,
 * guard ordering, default polarity).
 */

import type { PackV0 } from "@adjudicate/core"
import { ordersCapabilityPlanner } from "./capabilities.js"
import { ordersPolicyBundle } from "./policies.js"
import {
  PIX_CONFIRMATION_SIGNAL,
  type OrderContext,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "./types.js"

// ── Rehydrator ──────────────────────────────────────────────────────────

/**
 * Reconstitute an `OrderState` from a JSON-serializable representation.
 *
 * The state is already plain-object shape (no `Map`/`Set`/`Date` fields
 * inside `ctx`), so the rehydrator is a near-passthrough — its presence
 * documents intent ("this is the deserialization boundary") rather than
 * doing transformation. Permissive on input per the `PackV0.rehydrateState`
 * convention: malformed/missing fields fall back to empty defaults so
 * scenario fixtures and audit-replay payloads can be lenient while the
 * policy's guards remain the authoritative validators.
 */
export function rehydrateOrderState(raw: unknown): OrderState {
  if (typeof raw !== "object" || raw === null || !("ctx" in raw)) {
    return {
      ctx: {
        channel: "web",
        customerId: null,
        cartId: null,
        orderId: null,
      },
    }
  }
  const ctx = (raw as { ctx: unknown }).ctx
  if (typeof ctx !== "object" || ctx === null) {
    return {
      ctx: {
        channel: "web",
        customerId: null,
        cartId: null,
        orderId: null,
      },
    }
  }
  // Pass through — the policy guards validate the structural fields they
  // actually read; over-zealous type narrowing here would mask adopter
  // payload-shape bugs at deserialization rather than at adjudication.
  return raw as OrderState
}

// ── Re-exports for adopter convenience ──────────────────────────────────

export {
  CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS,
  ESCALATE_CANCEL_AMOUNT_CENTAVOS,
  ORDER_PIX_CONFIRMED_STATUSES,
  PIX_CONFIRMATION_SIGNAL,
  orderTaintPolicy,
  type OrderCartEnsurePayload,
  type OrderCartSyncPayload,
  type OrderCheckoutCreatePayload,
  type OrderContext,
  type OrderCancelPayload,
  type OrderCancelSystemPayload,
  type OrderCouponApplyPayload,
  type OrderItemAddPayload,
  type OrderItemRemovePayload,
  type OrderItemUpdatePayload,
  type OrderAmendRequestPayload,
  type OrderAmendAddItemPayload,
  type OrderAmendUpdateQtyPayload,
  type OrderAmendRemoveItemPayload,
  type OrderAddressChangePayload,
  type OrderTypeSwitchPayload,
  type OrderIntentKind,
  type OrderNoteAddPayload,
  type OrderPayload,
  type OrderPixDetailsSetPayload,
  type OrderProjectionCreatePayload,
  type OrderReviewSubmitPayload,
  type OrderFiscalEmitPayload,
  type OrderReorderPayload,
  type OrderReorderRequestPayload,
  type OrderCouponSwapRequestPayload,
  type OrderState,
  type OrderStatusTransitionPayload,
  type OrderStatusReconcilePayload,
} from "./types.js"

export {
  refuseAllergensNotExplicit,
  refuseAmbiguousOrderReference,
  refuseAmountExceedsLimit,
  refuseCartEmpty,
  refuseCheckoutMissingPaymentMethod,
  refuseDefault,
  refuseGuestCheckoutBlocked,
  refuseInvalidPaymentMethod,
  refuseInvalidQuantity,
  refuseInvalidRating,
  refuseNoCartId,
  refuseNoOrderToMutate,
  refuseCouponNotUsable,
  refuseNoPreviousOrder,
  refuseSwapTotalUnknown,
  refuseNotAuthenticated,
  refuseOrderAlreadyCancelled,
  refuseOrderAlreadyShipped,
  refuseOrderPastPonr,
  refuseQuantityOverLimit,
  refuseSlotsIncomplete,
  refuseTransitionIllegal,
  refuseTransitionStatusUnknown,
  refuseTransitionTerminal,
  portugueseRefusalMessages,
} from "./refusals.js"

export { ordersPolicyBundle } from "./policies.js"

// LE2-023 — the two sets a workflow FEASIBILITY PRE-CHECK must agree with,
// exported so the host reads the pack's own transcription instead of making a
// second one. See each set's comment for why a duplicate would be a real defect
// rather than a style point.
export {
  CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES,
  CUSTOMER_POST_PONR_FULFILLMENT,
} from "./policies.js"

// LE2-024 — the ONE paid-cancel confirm sentence, exported so the parity suite
// can assert both planes render it without re-spelling it a third time. A test
// that hard-coded the expected string would pass while both callers drifted
// together, which is exactly the agreement this function exists to remove.
export { paidCancelConfirmText } from "./policies.js"

export {
  ORDER_TOOL_TO_INTENT,
  ORDER_TOOLS,
  ordersCapabilityPlanner,
} from "./capabilities.js"

/**
 * The Pack as a `PackV0`-conformant value. The `satisfies` clause
 * provides compile-time conformance — drift from `PackV0`'s shape
 * fails the build. `intents` stays narrowly typed via the explicit
 * type parameters; the master taxonomy (governance §"Domain: order")
 * is the source of truth.
 *
 * Pack id convention matches `@adjudicate/pack-payments-pix.id =
 * "pack-payments-pix"`: short, no scope. The `ibatexas` org prefix
 * lives in the npm package name.
 */
export const ordersPack = {
  id: "ibatexas/pack-orders",
  version: "1.1.0",
  contract: "v0",
  intents: [
    // ═══ GENERATED — regenerate via `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds` after editing packages/catalog/src/capability-definitions/definitions.ts. DO NOT HAND-EDIT BELOW THIS LINE. ═══
    "order.cart.ensure",
    "order.item.add",
    "order.item.update",
    "order.item.remove",
    "order.cart.sync",
    "order.coupon.apply",
    "order.checkout.create",
    "order.pix.details.set",
    "order.cancel",
    "order.amend.request",
    "order.amend.add_item",
    "order.amend.update_qty",
    "order.amend.remove_item",
    "order.address.change",
    "order.type.switch",
    "order.note.add",
    "order.review.submit",
    "order.reorder",
    "order.reorder.request",
    "order.coupon.swap.request",
    "order.cancel.request",
    "order.coupon.adjust",
    "order.projection.create",
    "order.status.transition",
    "order.status.reconcile",
    "order.fiscal.emit",
    // ═══ END GENERATED REGION ═══
  ],
  policy: ordersPolicyBundle,
  planner: ordersCapabilityPlanner,
  /**
   * Refusal codes the Pack's policy may emit. The M3 AaC drift check
   * (`assertPackConformance` + `withBasisAudit`) verifies that
   * runtime emissions stay inside this set; new code added in
   * `refusals.ts` MUST be added here too.
   */
  basisCodes: [
    "auth.required",
    "auth.guest_checkout_blocked",
    "order.cart.empty",
    "order.cart.missing",
    "order.not_found",
    // BKL-216 — the amend in-message order-reference ambiguity CLARIFY
    // (`clarifyAmbiguousOrderReference`): the customer named ≥2 of their OWN
    // orders, so the resolver bound none and this asks which.
    "order.ambiguous_reference",
    "order.already_cancelled",
    "order.already_shipped",
    // LE2-021 — `confirmReorderLast`'s no-history REFUSE. Declared here at the
    // same time the builder was written, which is the whole lesson of the
    // BKL-251 note below.
    "order.reorder.no_history",
    // LE2-023 — `confirmSwapForCoupon`'s two OWN refusals, declared in the same
    // commit as their builders for the reason the BKL-251 note below records.
    // The guard's other two exits reuse `order.reorder.no_history` and
    // `order.past_ponr`, which are already declared here and are the same facts.
    "order.coupon.not_usable",
    "order.coupon.swap.total_unknown",
    // BKL-251 — emitted since BKL-036/034-F1 but never declared here, so the
    // AI-BOM and the config seal under-reported the Pack's refusal vocabulary.
    // `order.past_ponr` fires from `requireCancellable` (a customer cancel past
    // the point-of-no-return); `order.ownership_denied` from the 034-F1
    // ownership/IDOR guard `enforceOrderOwnership`, which is inert unless the
    // host injects `state.authority` — the reason AC-004's empty-state sampling
    // could never reach it.
    "order.past_ponr",
    "order.ownership_denied",
    "order.checkout.slots_incomplete",
    "order.checkout.payment_method_missing",
    "order.checkout.payment_method_invalid",
    "order.checkout.amount_exceeds_limit",
    "order.item.allergens_not_explicit",
    "order.item.quantity_invalid",
    "order.item.quantity_over_limit",
    "order.review.rating_invalid",
    // BKL-090 — kernel transition-legality guard refusal codes.
    "order.status.transition_illegal",
    "order.status.terminal",
    "order.status.unknown",
    "order.fiscal.not_eligible",
    "order.fiscal.retry_exceeded",
    "order.default.deny",
  ],
  /**
   * DEFER signal vocabulary. The Pack parks `order.checkout.create`
   * on `payment.confirmed` via the composed
   * `createPixPendingDeferGuard` factory. `@adjudicate/conformance`'s
   * AC-004 invariant check verifies that every DEFER decision the
   * policy emits carries a signal from this list.
   */
  signals: [PIX_CONFIRMATION_SIGNAL],
  rehydrateState: rehydrateOrderState,
} as const satisfies PackV0<
  OrderIntentKind,
  OrderPayload,
  OrderState,
  OrderContext
>
