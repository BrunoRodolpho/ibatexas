/**
 * Commerce-reference — PolicyBundle for a small order lifecycle.
 *
 * Demonstrates the IBX-IGE pattern at e-commerce scale:
 *
 *   - REWRITE clamps cart quantities to catalog `maxPerOrder` so the LLM
 *     can't propose 1000 items when stock allows 5.
 *   - DEFER parks `order.checkout` for PIX/async payment methods on a
 *     `payment.confirmed` signal; the parked envelope is resumed via
 *     `resumeDeferredIntent` from `@adjudicate/runtime` when the
 *     payment provider's webhook lands.
 *   - REFUSE handles the three commerce failure modes that are NOT
 *     security: empty cart, unknown SKU, and post-shipping mutation.
 *   - AUTH refusal gates checkout on customer authentication.
 *
 * REQUEST_CONFIRMATION and ESCALATE aren't shown here — the
 * vacation-approval example covers those — but adding them is one guard.
 */

import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionDefer,
  decisionRefuse,
  decisionRewrite,
} from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import {
  PAYMENT_CONFIRMATION_SIGNAL,
  PAYMENT_DEFER_TIMEOUT_MS,
  commerceTaintPolicy,
  type CommerceState,
  type OrderIntentKind,
} from "./types.js";
import {
  refuseEmptyCart,
  refuseNoOrderToCancel,
  refuseNotAuthenticated,
  refuseOrderAlreadyShipped,
  refuseUnknownSku,
} from "./refusals.js";

type CommerceGuard = Guard<OrderIntentKind, unknown, CommerceState>;

// ── State guards ────────────────────────────────────────────────────────────

/**
 * cart.add_item with a quantity exceeding the catalog's `maxPerOrder`
 * gets REWRITTEN to the cap. The LLM can ask for 1000; the kernel
 * delivers 5.
 */
const clampToCatalogMax: CommerceGuard = (envelope, state) => {
  if (envelope.kind !== "cart.add_item") return null;
  const payload = envelope.payload as {
    readonly sku: string;
    readonly quantity: number;
  };
  const entry = state.catalog.get(payload.sku);
  if (!entry) {
    return decisionRefuse(refuseUnknownSku(payload.sku), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "unknown_sku",
        sku: payload.sku,
      }),
    ]);
  }
  if (payload.quantity <= entry.maxPerOrder) return null;
  const rewritten = buildEnvelope({
    kind: envelope.kind,
    payload: { ...payload, quantity: entry.maxPerOrder },
    actor: envelope.actor,
    taint: envelope.taint,
    createdAt: envelope.createdAt,
  });
  return decisionRewrite(
    rewritten,
    `Quantity capped to catalog max for SKU ${payload.sku}.`,
    [
      basis("business", BASIS_CODES.business.QUANTITY_CAPPED, {
        sku: payload.sku,
        requested: payload.quantity,
        cappedTo: entry.maxPerOrder,
      }),
    ],
  );
};

const requireOrderForCancel: CommerceGuard = (envelope, state) => {
  if (envelope.kind !== "order.cancel") return null;
  if (state.order && state.order.status !== "shipped") return null;
  if (!state.order) {
    return decisionRefuse(refuseNoOrderToCancel(), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "no_order",
      }),
    ]);
  }
  // order exists but already shipped
  return decisionRefuse(refuseOrderAlreadyShipped(), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "already_shipped",
      orderId: state.order.id,
    }),
  ]);
};

// ── Auth guards ─────────────────────────────────────────────────────────────

/**
 * Checkout requires an authenticated customer. The cart can be built
 * anonymously; converting it to an order cannot.
 */
const requireAuthForCheckout: CommerceGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout") return null;
  if (state.customer.isAuthenticated) return null;
  return decisionRefuse(refuseNotAuthenticated(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
      attemptedKind: envelope.kind,
    }),
  ]);
};

// ── Business guards ─────────────────────────────────────────────────────────

/**
 * Empty carts can't check out. Pure business rule — not a security or
 * auth issue.
 */
const requireNonEmptyCartForCheckout: CommerceGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout") return null;
  if (state.cart.lines.length > 0) return null;
  return decisionRefuse(refuseEmptyCart(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "cart_empty",
    }),
  ]);
};

/**
 * order.checkout with payment method `pix` and a not-yet-confirmed
 * payment status defers on the `payment.confirmed` signal. The parked
 * envelope re-enters adjudication via `resumeDeferredIntent` when the
 * payment provider's webhook publishes the matching signal.
 *
 * Card payments don't defer here — they're synchronous in this model.
 */
const deferOnPendingPayment: CommerceGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout") return null;
  const payload = envelope.payload as {
    readonly paymentMethod?: "pix" | "card";
  };
  if (payload.paymentMethod !== "pix") return null;
  // Already confirmed (e.g. resume path) — let the kernel EXECUTE.
  if (state.order?.paymentStatus === "confirmed") return null;
  return decisionDefer(
    PAYMENT_CONFIRMATION_SIGNAL,
    PAYMENT_DEFER_TIMEOUT_MS,
    [
      basis("state", BASIS_CODES.state.TRANSITION_VALID, {
        reason: "payment_pending",
        waitFor: PAYMENT_CONFIRMATION_SIGNAL,
      }),
    ],
  );
};

// ── PolicyBundle ────────────────────────────────────────────────────────────

export const commercePolicyBundle: PolicyBundle<
  OrderIntentKind,
  unknown,
  CommerceState
> = {
  stateGuards: [clampToCatalogMax, requireOrderForCancel],
  authGuards: [requireAuthForCheckout],
  taint: commerceTaintPolicy,
  business: [requireNonEmptyCartForCheckout, deferOnPendingPayment],
  /**
   * `default: "REFUSE"` — fail-safe. An intent that no guard matched is
   * almost certainly an unanticipated path; refuse rather than execute.
   * Pair with EXECUTE-default if your domain prefers OPA-style "allow
   * unless explicitly denied."
   */
  default: "REFUSE",
};
