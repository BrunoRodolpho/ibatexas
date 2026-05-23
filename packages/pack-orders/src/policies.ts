/**
 * @ibatexas/pack-orders — PolicyBundle.
 *
 * Composed from `@adjudicate/primitives` factories
 * (`createSystemTaintPolicy`, `createConfirmGuard`, `createEscalateGuard`,
 * `createRewriteGuard`) and the lighthouse-Pack `createPixPendingDeferGuard`
 * factory from `@adjudicate/pack-payments-pix`. Default polarity is
 * REFUSE — per master plan §"Governance principles" #4 and
 * `governance/04-decision-policy.md` §"Default refuse policy".
 *
 * Guard ordering inside each phase matters. The PIX-DEFER guard fires
 * BEFORE the auth guards (kernel evaluation order: state → taint → auth
 * → business per ADR-104 / `@adjudicate/core/kernel/adjudicate.ts`); the
 * REWRITE clamp on `order.item.update` runs BEFORE the
 * quantity-cap REFUSE so adopters see a clamped envelope rather than a
 * blanket refusal when stock is depleted.
 *
 * # Migrated behaviour
 *
 * The LEGACY `orderPolicyBundle` from `packages/llm-provider/src/
 * order-policy-bundle.ts` is REPLACED bit-for-bit by this Pack's policy
 * (kernel evaluation against the migrated intent kinds produces
 * identical Decisions for the legacy fixtures — verified by
 * `__tests__/conformance.test.ts`). The legacy file becomes a
 * deprecated re-export shim.
 */

import {
  basis,
  BASIS_CODES,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
} from "@adjudicate/core"
import {
  nameGuard,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import {
  createConfirmGuard,
  createEscalateGuard,
  createRewriteGuard,
} from "@adjudicate/primitives"
import { createPixPendingDeferGuard } from "@adjudicate/pack-payments-pix"
import {
  refuseAllergensNotExplicit,
  refuseAmountExceedsLimit,
  refuseCartEmpty,
  refuseCheckoutMissingPaymentMethod,
  refuseDefault,
  refuseGuestCheckoutBlocked,
  refuseInvalidPaymentMethod,
  refuseInvalidQuantity,
  refuseNoCartId,
  refuseNoOrderToMutate,
  refuseNotAuthenticated,
  refuseOrderAlreadyCancelled,
  refuseOrderAlreadyShipped,
  refuseSlotsIncomplete,
} from "./refusals.js"
import {
  CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS,
  ESCALATE_CANCEL_AMOUNT_CENTAVOS,
  ORDER_PIX_CONFIRMED_STATUSES,
  orderTaintPolicy,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "./types.js"

type OrderGuard = Guard<OrderIntentKind, OrderPayload, OrderState>

// ── Helpers ─────────────────────────────────────────────────────────────

function isAuthenticated(state: OrderState): boolean {
  return state.ctx.customerId !== null
}

function canCheckout(state: OrderState): boolean {
  return state.ctx.channel === "whatsapp" || state.ctx.customerId !== null
}

function hasCartItems(state: OrderState): boolean {
  return (state.ctx.items?.length ?? 0) > 0
}

function hasOrderId(state: OrderState): boolean {
  return state.ctx.orderId !== null && state.ctx.orderId !== undefined
}

function canCancelOrder(state: OrderState): boolean {
  return hasOrderId(state) && state.ctx.lastAction !== "cancelled"
}

function canAmendOrder(state: OrderState): boolean {
  return hasOrderId(state) && state.ctx.lastAction !== "cancelled"
}

function allSlotsFilled(state: OrderState): boolean {
  return (
    state.ctx.fulfillment !== null &&
    state.ctx.fulfillment !== undefined &&
    state.ctx.paymentMethod !== null &&
    state.ctx.paymentMethod !== undefined
  )
}

const VALID_PAYMENT_METHODS = new Set(["pix", "card", "cash"])

// ── Auth guards ─────────────────────────────────────────────────────────

/**
 * Most user-touching intents require a known customer principal. The
 * exception is `order.cart.ensure` (anonymous get-or-create) and the
 * system-only `order.cancel.system` (taint gate enforces TRUSTED for
 * that kind separately).
 */
const requireAuthenticated: OrderGuard = (envelope, state) => {
  if (
    envelope.kind === "order.cart.ensure" ||
    envelope.kind === "order.cancel.system"
  ) {
    return null
  }
  if (isAuthenticated(state)) return null
  return decisionRefuse(refuseNotAuthenticated(), [
    basis("auth", BASIS_CODES.auth.IDENTITY_MISSING),
  ])
}

/**
 * Checkout has a stricter identity gate than the general auth: even on
 * WhatsApp (where the phone number is the identity), the customer row
 * must exist. The helper `canCheckout` mirrors the legacy
 * `machine/guards.ts:canCheckout`.
 */
const requireCheckoutEligibility: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout.create") return null
  if (canCheckout(state)) return null
  return decisionRefuse(refuseGuestCheckoutBlocked(), [
    basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT),
  ])
}

// ── State guards ────────────────────────────────────────────────────────

const requireCartIdForCartOps: OrderGuard = (envelope, _state) => {
  if (
    envelope.kind !== "order.item.add" &&
    envelope.kind !== "order.item.update" &&
    envelope.kind !== "order.item.remove" &&
    envelope.kind !== "order.coupon.apply" &&
    envelope.kind !== "order.checkout.create"
  ) {
    return null
  }
  const payload = envelope.payload as { cartId?: unknown }
  if (
    typeof payload.cartId === "string" &&
    payload.cartId.length > 0
  ) {
    return null
  }
  return decisionRefuse(refuseNoCartId(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "cart_id_missing",
    }),
  ])
}

const requireCartItemsForCheckout: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout.create") return null
  if (hasCartItems(state)) return null
  return decisionRefuse(refuseCartEmpty(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "cart_empty",
    }),
  ])
}

const requireSlotsFilledForCheckout: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout.create") return null
  if (allSlotsFilled(state)) return null
  return decisionRefuse(refuseSlotsIncomplete(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "slots_incomplete",
    }),
  ])
}

const requireOrderIdForMutation: OrderGuard = (envelope, state) => {
  if (
    envelope.kind !== "order.cancel" &&
    envelope.kind !== "order.cancel.system" &&
    envelope.kind !== "order.amend.request" &&
    envelope.kind !== "order.note.add"
  ) {
    return null
  }
  if (hasOrderId(state)) return null
  return decisionRefuse(refuseNoOrderToMutate(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "no_order",
    }),
  ])
}

const requireCancellable: OrderGuard = (envelope, state) => {
  if (
    envelope.kind !== "order.cancel" &&
    envelope.kind !== "order.cancel.system"
  ) {
    return null
  }
  if (canCancelOrder(state)) return null
  return decisionRefuse(refuseOrderAlreadyCancelled(), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "already_cancelled",
    }),
  ])
}

const requireAmendable: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.amend.request") return null
  if (canAmendOrder(state)) return null
  return decisionRefuse(refuseOrderAlreadyShipped(), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "already_shipped",
    }),
  ])
}

// ── PIX-pending DEFER (delegated to @adjudicate/pack-payments-pix) ──────

/**
 * Composed from the lighthouse Pack's factory per the existing
 * `order-policy-bundle.ts` pattern. The wire signal
 * (`PIX_CONFIRMATION_SIGNAL`), 15-minute timeout, and confirmed-status
 * set come from the Pack so consumers cannot silently diverge from
 * PIX semantics (CLAUDE.md rule #9).
 *
 * Confirmed-statuses set covers IbateXas's provider vocabulary
 * (`paid`, `captured`, `confirmed`) — same as the legacy
 * `order-policy-bundle.ts`.
 *
 * The Pack's `paymentsPixPack` Pack registers the signal in its
 * `signals` declaration; defer-resolver subscribers route the
 * `payment.confirmed` NATS event back to the kernel via
 * `resumeDeferredIntent` from `@adjudicate/runtime`.
 */
const deferOnPendingPix = nameGuard(
  "deferOnPendingPix",
  createPixPendingDeferGuard<OrderState>({
    readPaymentMethod: (state) => state.ctx.paymentMethod ?? null,
    readPaymentStatus: (state) => state.ctx.paymentStatus ?? null,
    matchesIntent: (kind) => kind === "order.checkout.create",
    confirmedStatuses: ORDER_PIX_CONFIRMED_STATUSES,
  }),
) as OrderGuard

// ── Business guards ─────────────────────────────────────────────────────

/**
 * SAFETY-CRITICAL: allergens must be an explicit string[]. Inferring
 * allergens from product name or text is the very attack-surface
 * CLAUDE.md hard rule #1 exists to block. Refuses if the payload is
 * missing the field, has a non-array, or has any non-string entry.
 */
const requireExplicitAllergens: OrderGuard = (envelope) => {
  if (envelope.kind !== "order.item.add") return null
  const payload = envelope.payload as { allergens?: unknown }
  const value = payload.allergens
  if (!Array.isArray(value)) {
    return decisionRefuse(
      refuseAllergensNotExplicit(`got=${typeof value}`),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "allergens_must_be_array",
          got: typeof value,
        }),
      ],
    )
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      return decisionRefuse(
        refuseAllergensNotExplicit(`non_string_entry`),
        [
          basis("business", BASIS_CODES.business.RULE_VIOLATED, {
            rule: "allergens_must_be_string_array",
            entryType: typeof entry,
          }),
        ],
      )
    }
  }
  return null
}

/**
 * Quantity must be a positive integer (centavos and quantities both
 * integer-only — CLAUDE.md rule #2 for prices; this guard enforces the
 * same polarity for line-item counts).
 */
const validateQuantity: OrderGuard = (envelope) => {
  if (
    envelope.kind !== "order.item.add" &&
    envelope.kind !== "order.item.update"
  ) {
    return null
  }
  const payload = envelope.payload as { quantity?: unknown }
  const q = payload.quantity
  if (typeof q !== "number" || !Number.isInteger(q) || q <= 0) {
    return decisionRefuse(refuseInvalidQuantity(q), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "quantity_positive_integer",
        seen: q,
      }),
    ])
  }
  return null
}

/**
 * REWRITE-clamp: `order.item.update` requesting a quantity above the
 * per-line `stockCap` rewrites to the cap. Adopters whose state does
 * not carry stock caps see this guard skip (extractor returns
 * undefined). The metadata declares `mutatesPayloadFields: ["quantity"]`
 * for the M3 REWRITE-scope analyzer (ADR-104).
 */
const clampUpdateToStockCap = nameGuard(
  "clampUpdateToStockCap",
  createRewriteGuard<OrderIntentKind, OrderPayload, OrderState>({
    matches: (env) => env.kind === "order.item.update",
    extract: (env, state) => {
      const payload = env.payload as { itemId: string; quantity: number }
      const item = state.ctx.items?.find(
        (i) => i.variantId === payload.itemId,
      )
      if (!item || item.stockCap === undefined) return undefined
      return payload.quantity
    },
    cap: (state, env) => {
      const payload = env.payload as { itemId: string; quantity: number }
      const item = state.ctx.items?.find(
        (i) => i.variantId === payload.itemId,
      )
      return item?.stockCap ?? Number.POSITIVE_INFINITY
    },
    mutateField: "quantity",
    reason: "Quantidade ajustada para o estoque disponível.",
  }),
) as OrderGuard

const validatePaymentMethod: OrderGuard = (envelope) => {
  if (envelope.kind !== "order.checkout.create") return null
  const payload = envelope.payload as { paymentMethod?: unknown }
  const m = payload.paymentMethod
  if (m === null || m === undefined) {
    return decisionRefuse(refuseCheckoutMissingPaymentMethod(), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "payment_method_required",
      }),
    ])
  }
  if (typeof m !== "string" || !VALID_PAYMENT_METHODS.has(m)) {
    return decisionRefuse(refuseInvalidPaymentMethod(m), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "payment_method_valid",
        seen: m,
      }),
    ])
  }
  return null
}

/**
 * Large-ticket checkout — REQUEST_CONFIRMATION at or above R$ 1.000
 * (100_000 centavos, per CLAUDE.md rule #2). Composed from
 * `@adjudicate/primitives.createConfirmGuard` so the threshold pattern
 * has a structurally-named factory; the adopter sees a typed prompt
 * and can localize the confirmation copy at presentation time.
 */
const confirmLargeTicket = nameGuard(
  "confirmLargeTicket",
  createConfirmGuard<OrderIntentKind, OrderPayload, OrderState>({
    matches: (env) => env.kind === "order.checkout.create",
    extract: (_env, state) => state.ctx.totalInCentavos ?? null,
    threshold: CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS,
    comparator: ">=",
    prompt: (value) =>
      `Esse pedido soma R$ ${(value / 100).toFixed(2).replace(".", ",")}. Confirma a finalização?`,
  }),
) as OrderGuard

/**
 * Refund-equivalent ESCALATION: customer-initiated `order.cancel` on a
 * large-ticket order (>= R$ 1.000) escalates to a human agent rather
 * than auto-cancelling. `order.cancel.system` (cron / subscriber) is
 * exempt — system auto-cancels don't escalate.
 */
const escalateLargeCancel = nameGuard(
  "escalateLargeCancel",
  createEscalateGuard<OrderIntentKind, OrderPayload, OrderState>({
    matches: (env) => env.kind === "order.cancel",
    extract: (_env, state) => state.ctx.totalInCentavos ?? null,
    threshold: ESCALATE_CANCEL_AMOUNT_CENTAVOS,
    comparator: ">=",
    to: "human",
    reason: (value) =>
      `Cancelamento de pedido com valor de R$ ${(value / 100).toFixed(2).replace(".", ",")} — atendente humano deve revisar.`,
  }),
) as OrderGuard

/**
 * Amount-cap REFUSE: orders above a per-deployment ceiling are refused
 * outright (i.e., orders above the escalation threshold * 10 — a
 * fail-stop for catalog mis-pricing or single-line abuse). Adopters
 * who want different behaviour wrap this Pack's policy with their own
 * additional business guards.
 */
const refuseAmountAboveCap: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.checkout.create") return null
  const total = state.ctx.totalInCentavos
  if (typeof total !== "number") return null
  // 10× the confirm threshold — R$ 10.000 default cap.
  const cap = CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS * 10
  if (total < cap) return null
  return decisionRefuse(refuseAmountExceedsLimit(total, cap), [
    basis("business", BASIS_CODES.business.RULE_VIOLATED, {
      rule: "amount_cap",
      total,
      cap,
    }),
  ])
}

// ── EXECUTE producers (default is REFUSE; positive matches required) ────

/**
 * Each "happy path" kind needs an explicit EXECUTE guard because the
 * Pack's default is REFUSE. The kernel's evaluation order means these
 * fire AFTER the state / auth / taint guards reject the failing cases.
 *
 * The guards are intentionally narrow — one per intent kind — so audit
 * basis carries the kind in a machine-readable form.
 */
const executeCartOps: OrderGuard = (envelope) => {
  if (
    envelope.kind === "order.cart.ensure" ||
    envelope.kind === "order.item.add" ||
    envelope.kind === "order.item.update" ||
    envelope.kind === "order.item.remove" ||
    envelope.kind === "order.coupon.apply"
  ) {
    return decisionExecute([
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        kind: envelope.kind,
      }),
    ])
  }
  return null
}

const executeCheckout: OrderGuard = (envelope) => {
  if (envelope.kind !== "order.checkout.create") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeCancel: OrderGuard = (envelope) => {
  if (
    envelope.kind === "order.cancel" ||
    envelope.kind === "order.cancel.system"
  ) {
    return decisionExecute([
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        kind: envelope.kind,
      }),
    ])
  }
  return null
}

const executeAmend: OrderGuard = (envelope) => {
  if (envelope.kind !== "order.amend.request") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const executeNoteAdd: OrderGuard = (envelope) => {
  if (envelope.kind !== "order.note.add") return null
  // Reject empty notes — defensive minimum.
  const payload = envelope.payload as { body?: unknown }
  if (typeof payload.body !== "string" || payload.body.length === 0) {
    return decisionRefuse(refuseDefault("note_body_empty"), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "note_body_non_empty",
      }),
    ])
  }
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

// ── PolicyBundle ────────────────────────────────────────────────────────

/**
 * The order-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel` to decide whether to execute a proposed
 * envelope. Default is REFUSE — any kind not covered by an explicit
 * EXECUTE guard is denied by construction.
 *
 * Phase order is fixed by the kernel: `state → taint → auth →
 * business → default`. The DEFER on pending PIX runs INSIDE
 * `stateGuards` so an UNTRUSTED LLM proposal still gets parked rather
 * than refused outright — the kernel runs state guards before the
 * taint gate (ADR-104, post-T8 reorder).
 */
export const ordersPolicyBundle: PolicyBundle<
  OrderIntentKind,
  OrderPayload,
  OrderState
> = {
  stateGuards: [
    requireCartIdForCartOps,
    requireOrderIdForMutation,
    requireCancellable,
    requireAmendable,
    requireCartItemsForCheckout,
    requireSlotsFilledForCheckout,
    deferOnPendingPix,
  ],
  authGuards: [requireAuthenticated, requireCheckoutEligibility],
  taint: orderTaintPolicy,
  business: [
    requireExplicitAllergens,
    validateQuantity,
    clampUpdateToStockCap,
    validatePaymentMethod,
    refuseAmountAboveCap,
    escalateLargeCancel,
    confirmLargeTicket,
    executeCartOps,
    executeCheckout,
    executeCancel,
    executeAmend,
    executeNoteAdd,
  ],
  /**
   * Fail-safe per master plan §"Governance principles" #4 — an intent
   * that no positive guard matched is REFUSEd. The kernel emits the
   * generic `default_deny` refusal (see `@adjudicate/locales-pt-BR`);
   * the Pack does not override at the bundle level.
   */
  default: "REFUSE",
}

// ── Re-exports for adopter convenience ──────────────────────────────────

/**
 * Suppress the unused-import warning for `decisionEscalate` —
 * `createEscalateGuard` consumes it internally via the primitive
 * factory; this re-export gives Pack authors a single import surface
 * if they want to compose additional escalation paths.
 */
export { decisionEscalate }
