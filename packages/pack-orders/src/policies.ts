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
  decisionRequestConfirmation,
} from "@adjudicate/core"
import {
  nameGuard,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import {
  createConfirmGuard,
  createDataClassificationGuard,
  createEscalateGuard,
  createRewriteGuard,
  requireTenantBinding,
} from "@adjudicate/primitives"
import {
  createPixPendingDeferGuard,
  CONFIRM_REFUND_THRESHOLD_CENTAVOS,
  ESCALATE_REFUND_THRESHOLD_CENTAVOS,
} from "@adjudicate/pack-payments-pix"
import { PII_PATTERNS } from "@ibatexas/pii"
import {
  canTransition,
  isKnownOrderStatus,
  isTerminalOrderStatus,
} from "@ibatexas/types"
import {
  refuseAllergensNotExplicit,
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
  refuseNotAuthenticated,
  refuseOrderAlreadyCancelled,
  refuseOrderAlreadyShipped,
  refuseOrderPastPonr,
  refuseOwnershipDenied,
  refuseSlotsIncomplete,
  refuseTransitionIllegal,
  refuseTransitionStatusUnknown,
  refuseTransitionTerminal,
} from "./refusals.js"
import { resolveOwnership } from "@adjudicate/core"
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

// ── PII data-classification (F1) ─────────────────────────────────────────────
// Two guards on the PIX / checkout free-text leaves. ORDER MATTERS: the PAN
// REFUSE MUST precede the REWRITE (first-non-null wins) so a payload carrying
// BOTH a card number and other PII is BLOCKED, not silently rewritten.
//   • refuseCardPanInPix — a 13–19-digit card run in name/email ⇒ REFUSE
//     (PII_BLOCKED). REFUSE never mutates data, so scanning the email leaf is
//     safe (only an actual card number trips it; an email/CPF cannot).
//   • redactPiiInPix — cpf/email/phone mistyped into the NAME leaf ⇒
//     REWRITE-to-sentinel in place. It deliberately does NOT scan the `email`
//     leaf (EMAIL_RE would mask a legitimate PIX email and corrupt settlement)
//     nor the structured `cpf` field (I10: a valid CPF must reach the executor
//     byte-identical). Patterns are sourced from @ibatexas/pii — the single
//     taxonomy shared with the audit redactor.
const PII_PAN_PATTERNS = PII_PATTERNS.filter((p) => p.id === "pan")
const PII_REWRITE_PATTERNS = PII_PATTERNS.filter((p) => p.id !== "pan")

const PIX_PII_KINDS = new Set<OrderIntentKind>([
  "order.pix.details.set",
  "order.checkout.create",
])

const refuseCardPanInPix: OrderGuard = nameGuard(
  "refuseCardPanInPix",
  createDataClassificationGuard<OrderIntentKind, OrderPayload, OrderState>({
    matches: (envelope) => PIX_PII_KINDS.has(envelope.kind),
    patterns: PII_PAN_PATTERNS,
    scannedFields: ["name", "email", "pixDetails.name", "pixDetails.email"],
    action: "REFUSE",
    sensitivityLevel: "critical",
    userFacing: "Não consigo processar dados de cartão neste fluxo.",
  }),
)

const redactPiiInPix: OrderGuard = nameGuard(
  "redactPiiInPix",
  createDataClassificationGuard<OrderIntentKind, OrderPayload, OrderState>({
    matches: (envelope) => PIX_PII_KINDS.has(envelope.kind),
    patterns: PII_REWRITE_PATTERNS,
    // NAME leaves only — never `email` (would mask the legitimate PIX email)
    // and never the structured `cpf` field (I10).
    scannedFields: ["name", "pixDetails.name"],
    action: "REWRITE",
    sensitivityLevel: "high",
    reason: "PII mascarado no payload antes da execução.",
  }),
)

// ── Helpers ─────────────────────────────────────────────────────────────

function isAuthenticated(state: OrderState): boolean {
  return state.ctx.customerId !== null
}

function canCheckout(state: OrderState): boolean {
  return state.ctx.channel === "whatsapp" || state.ctx.customerId !== null
}

/**
 * Guest CARD checkout is a supported flow. SEC-001 (apps/api/src/routes/cart.ts)
 * allows an unauthenticated checkout ONLY for `paymentMethod === "card"` (Stripe
 * validates the card identity); cash/PIX still require auth (and SEC-001 401s a
 * guest cash/PIX checkout before the kernel is reached). RC-A1 cutover D-24 Ruling 2:
 * exempt guest CARD checkout from the identity gates, scoped to card PRECISELY — NOT
 * a blanket guest-checkout exemption (over-widening would open guest cash/PIX, which
 * the live system does not support). Pack-guard layer only — reads
 * `envelope.payload.paymentMethod`; no principal/hash change.
 */
function isCardCheckout(envelope: {
  readonly kind: string
  readonly payload: unknown
}): boolean {
  return (
    envelope.kind === "order.checkout.create" &&
    (envelope.payload as { paymentMethod?: unknown }).paymentMethod === "card"
  )
}

function hasCartItems(state: OrderState): boolean {
  return (state.ctx.items?.length ?? 0) > 0
}

function hasOrderId(state: OrderState): boolean {
  return state.ctx.orderId !== null && state.ctx.orderId !== undefined
}

// Fulfillment statuses past the cancellation point-of-no-return.
// POST_PONR_FULFILLMENT is the SYSTEM-actor floor: once an order is ready / out
// for delivery / delivered, not even a system/compensation cancel may proceed.
// `canceled` is handled separately (already-cancelled, not PONR).
const POST_PONR_FULFILLMENT: ReadonlySet<string> = new Set([
  "ready",
  "in_delivery",
  "delivered",
])

// CUSTOMER-facing PONR additionally includes "preparing": once the kitchen is
// preparing, a customer self-serve cancel is DENIED + escalated — mirrors the
// route-layer canPerformAction("cancel_order") rule (order-action-validator.ts,
// "Cozinha já está preparando"). A SYSTEM actor (order.cancel.system: payment-
// expiry / stale-order compensation) is NOT bound by the preparing PONR and may
// still cancel a preparing order.
const CUSTOMER_POST_PONR_FULFILLMENT: ReadonlySet<string> = new Set([
  ...POST_PONR_FULFILLMENT,
  "preparing",
])

// BKL-036 (J015) — payment statuses in which the customer's money is already
// SETTLED (captured), so a customer `order.cancel` implies a REFUND of the
// order total. Reuses the confirmed-payment set (`paid`/`captured`/`confirmed`,
// the same vocabulary the PIX-defer guard treats as settled) and adds the two
// further money-held statuses a paid order can be in (`partially_refunded`,
// `disputed`). NOT settled: awaiting_payment / payment_pending / cash_pending
// (nothing captured yet) and refunded / canceled / waived (money already
// returned or the order already terminal). Drives `gatePaidCancel`.
const CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  ...ORDER_PIX_CONFIRMED_STATUSES,
  "partially_refunded",
  "disputed",
])

function orderAlreadyCancelled(state: OrderState): boolean {
  return state.ctx.lastAction === "cancelled" || state.ctx.fulfillmentStatus === "canceled"
}

function canCancelOrder(state: OrderState, isSystem: boolean): boolean {
  if (!hasOrderId(state)) return false
  if (orderAlreadyCancelled(state)) return false
  const fs = state.ctx.fulfillmentStatus
  if (typeof fs !== "string") return true
  const ponr = isSystem ? POST_PONR_FULFILLMENT : CUSTOMER_POST_PONR_FULFILLMENT
  return !ponr.has(fs)
}

// BKL-036 finding 3 (tier a) — amend point-of-no-return. Mirrors the cancel
// PONR floor (`canCancelOrder`, above): once the order is out of the kitchen's
// control (ready / out-for-delivery / delivered) OR already cancelled, a
// customer amend is past the point of no return. Uses `POST_PONR_FULFILLMENT`
// (the hard floor) rather than the CUSTOMER set so an add-item to a still-
// `preparing` order stays allowed — the route validator's `checkAddItem`
// permits preparing adds, and blocking it here would regress that flow.
// Tier (a) is fulfillment-state gating ONLY; the order-age time-window
// (createdAt / amendPonrMinutes) is tier (b), out of scope. Lenient when the
// host has not projected a status (`fs` absent) so a caller that does not carry
// order state is unaffected — same posture as `canCancelOrder`.
function canAmendOrder(state: OrderState): boolean {
  if (!hasOrderId(state)) return false
  if (orderAlreadyCancelled(state)) return false
  const fs = state.ctx.fulfillmentStatus
  if (typeof fs !== "string") return true
  return !POST_PONR_FULFILLMENT.has(fs)
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
 * Tenant binding (AuthReviewer-009 / RC-A1 D-12). The app supplies the request's
 * tenant in `state.ctx.tenantId` (the conductor resolver sets the single tenant);
 * this REFUSEs a request whose state tenant is not the configured tenant. Lenient
 * when absent (the gateway/legacy path does not yet supply it) so it is a correct
 * no-op today AND a real seam once the multi-tenant actor model lands. Reads
 * (actor, state) → Decision — touches no principal shape / hashed byte (D-12).
 * Tenant id is env-driven (Hard Rule #3), defaulting to the single tenant.
 */
const requireTenantBindingGuard: OrderGuard = requireTenantBinding<
  OrderIntentKind,
  OrderPayload,
  OrderState
>((_actor, state) => {
  const tenant = state.ctx.tenantId
  return tenant === undefined || tenant === (process.env.KERNEL_TENANT_ID ?? "ibatexas")
})

/**
 * Most user-touching intents require a known customer principal. The
 * exceptions are `order.cart.ensure` (anonymous get-or-create) and the
 * system-only kinds (`order.cancel.system`, `order.projection.create`,
 * `order.status.reconcile`); the taint gate enforces TRUSTED for those
 * separately. `order.status.transition` is admin/system; auth is at
 * the route layer.
 */
const SYSTEM_OR_ANON_KINDS: ReadonlySet<string> = new Set([
  "order.cart.ensure",
  "order.cancel.system",
  "order.projection.create",
  "order.status.transition",
  "order.status.reconcile",
])

/**
 * Cart-building intents a GUEST (unauthenticated web visitor) may perform
 * BEFORE authenticating at checkout. These mirror the HTTP cart routes
 * (`apps/api/src/routes/cart.ts`), which gate on `optionalAuth` + a
 * cart-scoped `verifyCartOwnership` (Redis cart:owner claim) — NOT on a
 * customer principal. The identity gate for this flow lives at CHECKOUT
 * (`requireCheckoutEligibility` / `canCheckout`), not at cart-building, so
 * routing these through the kernel must not regress guest shopping. `cartId`
 * presence is still enforced by `requireCartIdForCartOps`, explicit allergens
 * by `requireExplicitAllergens`, and cart ownership at the route layer.
 *
 * RC-A1 cutover Chunk 0 (cycle 20, DECISIONS-cycle20 D-20.4): a pack-guard
 * change only — it does NOT alter the envelope/principal shape or any hashed
 * byte (guest cart needs a pack-guard change, not a principal). adj core is
 * untouched (stays at its tripwire count).
 */
const GUEST_CART_KINDS: ReadonlySet<string> = new Set([
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.cart.sync",
  "order.coupon.apply",
])

const requireAuthenticated: OrderGuard = (envelope, state) => {
  if (SYSTEM_OR_ANON_KINDS.has(envelope.kind)) {
    return null
  }
  // Guests may build a cart; the identity gate is at checkout, not here.
  if (GUEST_CART_KINDS.has(envelope.kind)) {
    return null
  }
  // Guest CARD checkout is allowed (SEC-001 / D-24 Ruling 2) — card only; cash/PIX
  // checkout still require auth (a guest cash/PIX checkout is 401'd by SEC-001 before
  // it reaches the kernel, so this never under-protects them).
  if (isCardCheckout(envelope)) {
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
  // Guest CARD checkout is allowed (SEC-001 / D-24 Ruling 2) — card only.
  if (isCardCheckout(envelope)) return null
  return decisionRefuse(refuseGuestCheckoutBlocked(), [
    basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT),
  ])
}

// ── State guards ────────────────────────────────────────────────────────

const CART_OPS_REQUIRING_CART_ID: ReadonlySet<string> = new Set([
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.cart.sync",
  "order.coupon.apply",
  "order.checkout.create",
  "order.pix.details.set",
])

const requireCartIdForCartOps: OrderGuard = (envelope, _state) => {
  if (!CART_OPS_REQUIRING_CART_ID.has(envelope.kind)) {
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

const ORDER_OPS_REQUIRING_ORDER_ID: ReadonlySet<string> = new Set([
  "order.cancel",
  "order.cancel.system",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.note.add",
  "order.address.change",
  "order.type.switch",
  "order.review.submit",
  "order.status.transition",
  "order.status.reconcile",
])

const requireOrderIdForMutation: OrderGuard = (envelope, state) => {
  if (!ORDER_OPS_REQUIRING_ORDER_ID.has(envelope.kind)) {
    return null
  }
  if (hasOrderId(state)) return null
  return decisionRefuse(refuseNoOrderToMutate(), [
    basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
      reason: "no_order",
    }),
  ])
}

// ── Kernel transition-legality guard (BKL-090) ──────────────────────────────
//
// The SECURITY-critical gate that makes an LLM-proposed kitchen-advance
// (`order.status.transition`) safe to reach EXECUTE on the ops/staff plane.
//
// Before this guard, NEITHER this pack's bundle NOR the domain
// `orderProjectionPolicyBundle` gated transition LEGALITY / TERMINAL state at
// the kernel — BOTH deferred validity to the imperative executor
// `executeTransition` (order-command.service.ts), which THROWS
// `InvalidTransitionError` INSIDE the DB transaction. A throw is not a kernel
// Decision: an illegal transition (e.g. delivered→preparing) reached kernel
// EXECUTE and relied on an executor exception for safety. That is acceptable
// for the TRUSTED system/admin executor path, but NOT for an LLM-proposed ops
// verb. This guard closes the gap at the kernel for the composed (ops) path.
//
// DIVISION OF RESPONSIBILITY (kept crisp, do not blur):
//   • KERNEL (this guard): LEGALITY (target ∈ legal-next(current)) + TERMINALITY
//     (current has no legal next) + fail-closed on an unknown/absent status.
//     REUSES `canTransition` / `isTerminalOrderStatus` / `isKnownOrderStatus`
//     from `@ibatexas/types` — the SINGLE source of truth the executor imports
//     too. It NEVER re-declares the transition graph.
//   • EXECUTOR (order-command.service.ts): optimistic-CONCURRENCY (version race)
//     + ATOMICITY. A version race is inherently executor-transactional — the
//     kernel adjudicates a pre-read snapshot and cannot see a concurrent bump —
//     so the executor's version check AND its `canTransition` throw REMAIN as
//     the last transactional line (defense-in-depth against a resolve→execute
//     race). This guard does NOT attempt optimistic concurrency.
//
// STATE-SHAPE / FAIL-CLOSED posture (investigated per live path):
//   • This pack's bundle for `order.status.transition` is reached LIVE only by
//     the ops/staff plane (`composePolicyRouter` → this pack; `admin:<staffId>`
//     session). The ops resolver projects the CURRENT status into
//     `state.ctx.fulfillmentStatus`; a missing order yields `orderId:null` ⇒
//     `requireOrderIdForMutation` REFUSEs `no_order` BEFORE this guard runs.
//   • The admin HTTP command-service / subscriber / job paths adjudicate the
//     kind against the DOMAIN `orderProjectionPolicyBundle` (NOT this bundle),
//     whose executor-throw contract their tests assert. This guard neither runs
//     nor changes anything there.
//   • Fail-closed on an ABSENT status is scoped to `admin:` sessions ONLY. A
//     non-`admin:` envelope that projects no status (the pack's generic
//     conformance contract — it has no live caller for this kind) keeps its
//     existing verdict, so no green path/test flips. An `admin:` envelope MUST
//     carry a projected status; its absence is a resolver defect → REFUSE.
const requireLegalStatusTransition: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.status.transition") return null
  const current = state.ctx.fulfillmentStatus
  const target = (envelope.payload as { newStatus?: unknown }).newStatus
  const isStaffPlane = envelope.actor.sessionId.startsWith("admin:")

  // (1) Absent / non-string current status.
  if (typeof current !== "string") {
    // Non-admin generic contract projects no status here (no live caller) —
    // leave its verdict untouched. The admin: ops path MUST project a status;
    // its absence fails closed.
    if (!isStaffPlane) return null
    return decisionRefuse(
      refuseTransitionStatusUnknown("current_status_absent"),
      [
        basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
          reason: "current_status_absent",
        }),
      ],
    )
  }
  // (2) Current status is not one of the seven known statuses — fail closed.
  if (!isKnownOrderStatus(current)) {
    return decisionRefuse(refuseTransitionStatusUnknown(`current=${current}`), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "current_status_unknown",
        current,
      }),
    ])
  }
  // (3) Target must be one of the seven known statuses.
  if (typeof target !== "string" || !isKnownOrderStatus(target)) {
    return decisionRefuse(
      refuseTransitionStatusUnknown(`target=${String(target)}`),
      [
        basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
          reason: "target_status_unknown",
          target: typeof target === "string" ? target : null,
        }),
      ],
    )
  }
  // (4) Terminal current state — a distinct refusal from a merely illegal
  //     target (delivered / canceled have no legal next state).
  if (isTerminalOrderStatus(current)) {
    return decisionRefuse(refuseTransitionTerminal(current), [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "current_status_terminal",
        current,
      }),
    ])
  }
  // (5) Target is not a legal next state from the current status.
  if (!canTransition(current, target)) {
    return decisionRefuse(refuseTransitionIllegal(current, target), [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "transition_not_legal",
        from: current,
        to: target,
      }),
    ])
  }
  // Legal transition — fall through to `executeW5Kinds` (business EXECUTE).
  return null
}

/**
 * FE-T05 (Language Engine) — a GROUNDED (auto-resolved "most recent order")
 * `order.status.transition` target ALWAYS parks for confirmation, never
 * silently EXECUTEs. Placed in `business` (after `requireLegalStatusTransition`
 * in `stateGuards` already REFUSEd an illegal/terminal/unknown transition) so
 * a guessed target is asked about ONLY when the transition would otherwise be
 * legal — an illegal guess REFUSEs outright with the precise reason, never a
 * confusing "confirm an action that would fail anyway" prompt.
 *
 * Engagement is `state.ctx.orderResolutionTrust === "grounded"` — set ONLY by
 * the ops resolver's `resolveStatusTransitionOrderTarget` fallback
 * (`ops-resolver.ts`) when the model gave NO order reference at all (this
 * tracer's only live path today: the FE-1.1 extraction schema never shows the
 * model an orderId/reference field for this capability). Absent/`"authoritative"`
 * ⇒ null (pass-through) — an explicit staff reference (a future rollout slice
 * may re-add that field) is NOT re-confirmed here.
 *
 * Resolved EXACTLY like the large-ticket checkout / paid-cancel confirms: the
 * IDENTICAL envelope re-adjudicated with a matching `confirmationReceipt`
 * flips this guard's verdict to EXECUTE via the kernel's 2a override, while
 * every other guard (incl. `requireLegalStatusTransition`) re-runs in full —
 * so a state change between park and confirm (e.g. the order already reached
 * a terminal status) still REFUSEs on resume, never silently EXECUTEs.
 */
const requireConfirmationOnGroundedStatusTransition: OrderGuard = (
  envelope,
  state,
) => {
  if (envelope.kind !== "order.status.transition") return null
  if (state.ctx.orderResolutionTrust !== "grounded") return null
  const target = (envelope.payload as { newStatus?: unknown }).newStatus
  const targetLabel = typeof target === "string" ? target : "esse status"
  // FE-T05 review (MAJOR-2) — NAME the guessed order (its display number) so
  // an operator confirming can actually recognize (and reject) a wrong
  // guess; a prompt that names nothing defeats the point of forcing a
  // confirmation. `displayId` is set by the resolver alongside
  // `orderResolutionTrust: "grounded"` (ops-resolver.ts); the fallback below
  // is defensive only — it should not be reachable in practice.
  const orderLabel =
    typeof state.ctx.displayId === "number"
      ? `o pedido #${state.ctx.displayId}`
      : "o pedido mais recente em aberto"
  return decisionRequestConfirmation(
    `Não me disseram qual pedido — vou usar ${orderLabel}. ` +
      `Confirma avançar ${orderLabel} para "${targetLabel}"?`,
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "grounded_order_resolution_requires_confirmation",
        resolvedVia: "most_recent_active_order",
        ...(typeof state.ctx.displayId === "number"
          ? { displayId: state.ctx.displayId }
          : {}),
      }),
    ],
  )
}

const requireCancellable: OrderGuard = (envelope, state) => {
  if (
    envelope.kind !== "order.cancel" &&
    envelope.kind !== "order.cancel.system"
  ) {
    return null
  }
  // System/compensation cancels (order.cancel.system, actor.principal="system")
  // may still cancel a "preparing" order; a customer self-serve cancel may not
  // (route denies + escalates). actor.principal is forgery-checked upstream.
  const isSystem = envelope.actor.principal === "system"
  if (canCancelOrder(state, isSystem)) return null
  // Distinguish an already-cancelled order from one past the point-of-no-return
  // so the audit basis is accurate.
  if (orderAlreadyCancelled(state)) {
    return decisionRefuse(refuseOrderAlreadyCancelled(), [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "already_cancelled",
      }),
    ])
  }
  return decisionRefuse(refuseOrderPastPonr(), [
    basis("state", BASIS_CODES.state.TERMINAL_STATE, {
      reason: "past_ponr",
    }),
  ])
}

// 034-F1 — kernel ownership/IDOR guard (defense-in-depth). Engages ONLY when the
// host injects `state.authority` (a per-customer authority graph of OWNED
// resources + a session→principal map). The order money kinds bind to the order
// resource via `resourceRefs`; a resource the customer does not own is unbound in
// the graph ⇒ REFUSE (de-vacuumed — see the pack-orders ownership canary test).
const OWNERSHIP_GATED_ORDER_KINDS: ReadonlySet<string> = new Set([
  "order.cancel",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
])

interface OwnershipAuthority {
  readonly store: Parameters<typeof resolveOwnership>[0]
  readonly principalOf?: (sessionId: string) => string | null
}

const enforceOrderOwnership: OrderGuard = (envelope, state) => {
  const authority = (state as { authority?: OwnershipAuthority }).authority
  if (authority === undefined) return null // inert unless the host injects authority
  if (!OWNERSHIP_GATED_ORDER_KINDS.has(envelope.kind)) return null
  const fact = resolveOwnership(authority.store, envelope)
  // (1) Binding: the declared owner must actually own the resource in the graph.
  if (!fact.bound) {
    return decisionRefuse(refuseOwnershipDenied(), [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { reason: "resource_not_owned" }),
    ])
  }
  // (2) IDOR gate: the AUTHENTICATED principal behind the acting session must
  // EQUAL the resource owner. `principalOf` is the host's authenticated
  // session→principal binding (sourced from the conductor-authenticated session,
  // INDEPENDENT of the envelope's self-reported actor.sessionId — see
  // authority-wiring.ts), so a session that is not the authenticated owner (a
  // forged / cross-session / unbound-agent actor) resolves to null and is REFUSEd.
  const authed = authority.principalOf?.(envelope.actor.sessionId) ?? null
  if (authed === null || authed !== fact.principal) {
    return decisionRefuse(refuseOwnershipDenied(), [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { reason: "tenant_binding_violation" }),
    ])
  }
  return null
}

const AMEND_KINDS: ReadonlySet<string> = new Set([
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
])

const requireAmendable: OrderGuard = (envelope, state) => {
  if (!AMEND_KINDS.has(envelope.kind)) return null
  if (canAmendOrder(state)) return null
  // Distinguish an already-cancelled order from one past the amend PONR so the
  // audit basis is accurate (mirrors requireCancellable's two-case split).
  if (orderAlreadyCancelled(state)) {
    return decisionRefuse(refuseOrderAlreadyCancelled(), [
      basis("state", BASIS_CODES.state.TERMINAL_STATE, {
        reason: "already_cancelled",
      }),
    ])
  }
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
const pixPendingDeferBase = createPixPendingDeferGuard<OrderState>({
  readPaymentMethod: (state) => state.ctx.paymentMethod ?? null,
  readPaymentStatus: (state) => state.ctx.paymentStatus ?? null,
  matchesIntent: (kind) => kind === "order.checkout.create",
  confirmedStatuses: ORDER_PIX_CONFIRMED_STATUSES,
})

/**
 * RC-A1 cutover D-24 Ruling 1: a FRESH PIX checkout (paymentStatus null/undefined)
 * EXECUTEs immediately — `createCheckout` generates the PIX QR and the already-routed
 * `payment.status.reconcile` webhook path governs confirmation (the architecture is
 * QR-first-then-confirm, NOT defer-until-paid; you cannot confirm a payment that was
 * never generated). Only an explicitly in-flight, non-null UNCONFIRMED PIX status
 * still DEFERs (the cognitive-loop re-entry scenario). This scopes the lighthouse
 * PIX-defer guard at the orders-pack composition layer without touching the
 * `@adjudicate/pack-payments-pix` factory (zero hashed byte).
 */
const deferOnPendingPix = nameGuard(
  "deferOnPendingPix",
  (envelope, state) => {
    if ((state as OrderState).ctx.paymentStatus == null) return null
    return pixPendingDeferBase(envelope, state as OrderState)
  },
) as OrderGuard

// ── Business guards ─────────────────────────────────────────────────────

/**
 * SAFETY-CRITICAL: allergens must be an explicit string[]. Inferring
 * allergens from product name or text is the very attack-surface
 * CLAUDE.md hard rule #1 exists to block. Refuses if the payload is
 * missing the field, has a non-array, or has any non-string entry.
 */
const KINDS_REQUIRING_EXPLICIT_ALLERGENS: ReadonlySet<string> = new Set([
  "order.item.add",
  "order.amend.add_item",
])

const requireExplicitAllergens: OrderGuard = (envelope) => {
  // BULK (order.cart.sync) — EVERY line item must carry an explicit `allergens`
  // string[] (Hard Rule #1: never infer allergens from a product name/text). This
  // is the precondition BKL-180 wires the kind over: fail-closed REFUSE listing the
  // offending items. Handled BEFORE the single-payload early-return below because a
  // cart-sync payload carries `items`, not a top-level `allergens`. A MISSING/non-array
  // `items` REFUSEs (fail-closed); an EMPTY items array is a no-op pass (nothing to
  // sync — the checkout edge-handling around syncLocalCartForCheckout owns that case).
  if (envelope.kind === "order.cart.sync") {
    const items = (envelope.payload as { items?: unknown }).items
    if (!Array.isArray(items)) {
      return decisionRefuse(
        refuseAllergensNotExplicit(`cart_sync_items_not_array got=${typeof items}`),
        [
          basis("business", BASIS_CODES.business.RULE_VIOLATED, {
            rule: "cart_sync_items_must_be_array",
            got: typeof items,
          }),
        ],
      )
    }
    const offending: string[] = []
    items.forEach((item, i) => {
      const raw = item as { variantId?: unknown; allergens?: unknown } | null
      const allergens = raw?.allergens
      const explicit =
        Array.isArray(allergens) && allergens.every((e) => typeof e === "string")
      if (!explicit) {
        const vid = raw?.variantId
        offending.push(typeof vid === "string" && vid !== "" ? vid : `index_${i}`)
      }
    })
    if (offending.length > 0) {
      return decisionRefuse(
        refuseAllergensNotExplicit(
          `cart_sync_items_missing_allergens: ${offending.join(",")}`,
        ),
        [
          basis("business", BASIS_CODES.business.RULE_VIOLATED, {
            rule: "cart_sync_items_must_carry_explicit_allergens",
            offendingItems: offending,
          }),
        ],
      )
    }
    return null
  }
  if (!KINDS_REQUIRING_EXPLICIT_ALLERGENS.has(envelope.kind)) return null
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
const KINDS_REQUIRING_QUANTITY: ReadonlySet<string> = new Set([
  "order.item.add",
  "order.item.update",
  "order.amend.add_item",
  "order.amend.update_qty",
])

const validateQuantity: OrderGuard = (envelope) => {
  if (!KINDS_REQUIRING_QUANTITY.has(envelope.kind)) {
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
 * BKL-036 finding 2 (J015) — PAID-state cancel gating.
 *
 * A customer `order.cancel` on an order whose payment is already SETTLED
 * (money captured — `state.ctx.paymentStatus` ∈
 * `CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES`) implies a REFUND of the order
 * total. Before this guard NO pack-orders guard read the paid state for
 * `order.cancel`: a paid cancel reached kernel EXECUTE, the executor then
 * attempted an ILLEGAL `paid → canceled` payment transition, 409'd
 * (P2-LOGIC-CANCELPAY), and left a CANCELED order with a live PAID payment —
 * the JOURNEY-015 header's documented gap and the reachability half of the
 * BKL-130 half-applied-state defect. This guard moves the paid-state decision
 * INTO the kernel, following the refund-magnitude band idiom and reusing the
 * CANONICAL band thresholds from `@adjudicate/pack-payments-pix` (the source
 * `@ibatexas/pack-payments` itself mirrors):
 *
 *   unpaid (no settled payment)                       → null  (unchanged — the
 *                                                        fulfillment-state PONR
 *                                                        guards govern)
 *   paid + refund-equivalent ≥ ESCALATE threshold      → ESCALATE (human)
 *   paid + refund-equivalent  < ESCALATE threshold      → REQUEST_CONFIRMATION
 *
 * A paid cancel therefore NEVER silently EXECUTEs — it parks in the low/medium
 * band and escalates in the high band. The refund-equivalent magnitude is the
 * order total (`state.ctx.totalInCentavos`, the amount that would be returned),
 * read exactly as `escalateLargeCancel` reads it; when the host has not
 * projected a total the guard still parks (never EXECUTEs). Placed BEFORE
 * `escalateLargeCancel` so the PAID path is owned here in full (both bands
 * reachable + audited with a paid-specific basis) while `escalateLargeCancel`
 * continues to govern the UNPAID large-cancel escalation unchanged. The
 * REQUEST_CONFIRMATION is resolved exactly like the large-ticket checkout
 * confirm — the identical envelope re-adjudicated with a matching
 * `confirmationReceipt`, which the kernel's 2a override flips to EXECUTE while
 * still re-running every state/taint/auth guard. `order.cancel.system` (cron /
 * subscriber compensation) is not matched — a system auto-cancel never asks the
 * customer to confirm a refund. The `CONFIRM_REFUND_THRESHOLD_CENTAVOS` band
 * boundary is carried on the audit basis for provenance; because even a
 * sub-confirm-threshold paid cancel parks, it does not change the two-band
 * verdict (a paid cancel below the escalate threshold always confirms).
 */
const gatePaidCancel: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.cancel") return null
  const ps = state.ctx.paymentStatus
  if (
    typeof ps !== "string" ||
    !CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES.has(ps)
  ) {
    return null // no settled payment ⇒ a cancel implies no refund ⇒ unchanged
  }
  const refundEquivalentCentavos = state.ctx.totalInCentavos ?? null
  const reais =
    typeof refundEquivalentCentavos === "number"
      ? (refundEquivalentCentavos / 100).toFixed(2).replace(".", ",")
      : null
  // High band: a large paid cancel escalates to a human (mirrors the refund
  // ESCALATE band + escalateLargeCancel's >= comparator/threshold).
  if (
    typeof refundEquivalentCentavos === "number" &&
    refundEquivalentCentavos >= ESCALATE_REFUND_THRESHOLD_CENTAVOS
  ) {
    return decisionEscalate(
      "human",
      "paid_cancel_refund_above_escalate_threshold",
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          reason: "paid_cancel_refund_above_escalate_threshold",
          refundEquivalentCentavos,
          escalateThreshold: ESCALATE_REFUND_THRESHOLD_CENTAVOS,
          paymentStatus: ps,
        }),
      ],
    )
  }
  // Low / medium band: park for explicit confirmation — a paid cancel is a
  // real-money refund and must never silently EXECUTE.
  return decisionRequestConfirmation(
    reais === null
      ? "Esse pedido já foi pago. Cancelar implica reembolso — confirma o cancelamento?"
      : `Esse pedido já foi pago (R$ ${reais}). Cancelar implica reembolso ao cliente — confirma o cancelamento?`,
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "paid_cancel_requires_confirmation",
        refundEquivalentCentavos,
        confirmThreshold: CONFIRM_REFUND_THRESHOLD_CENTAVOS,
        escalateThreshold: ESCALATE_REFUND_THRESHOLD_CENTAVOS,
        paymentStatus: ps,
      }),
    ],
  )
}

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

/**
 * SDD §O#10 — adjacent-type confident-wrong (the one clause under topology
 * pressure; resolution (a): a stakes-aware REQUEST_CONFIRMATION).
 *
 * `order.amend.add_item` (add a line to a **placed order** — REAL MONEY,
 * post-checkout) and `order.item.add` (a **cart** op — low stakes,
 * pre-checkout) are *adjacent* intents (claim-registry §1: the corrected
 * "coloca uma coca" example resolves to `order.amend.add_item`, NOT
 * `order.item.add`). No data-independent gate fires to distinguish a
 * planner mis-frame between the two: the capability catalog passes (both
 * kinds are in the enum), `outcomeConfirmed` passes (the wrong action
 * *truly* executes), the P2 set is consistent (one claim), and P4 maps the
 * span (to the wrong sibling). So a wrong-but-adjacent real-money action
 * would EXECUTE and narrate truthfully — the single place the §2/§C
 * fail-safe guarantee was *overstated* (pressure-test §4 #10).
 *
 * Resolution: the higher-stakes adjacent action (the placed-order amend that
 * ADDS an item) degrades to `REQUEST_CONFIRMATION` UNLESS the host has set a
 * deterministic disambiguation flag (`state.ctx.amendItemConfirmed === true`)
 * recording that the user's intent to amend a *placed order* (vs. build a
 * cart) was confirmed. The low-stakes cart op (`order.item.add`) is NOT
 * matched here and keeps its `executeCartOps` EXECUTE path, so a mis-frame
 * toward real money is caught while normal cart-building is untouched.
 *
 * Properties (auditor, scrutinize these):
 *   • Stakes-aware by KIND, NOT by amount — it keys solely on the
 *     `order.amend.add_item` kind, never reads `totalInCentavos`, and never
 *     alters the Inv 11 refund/checkout/cancel amount-band verdicts. It is
 *     ADDITIVE governance, orthogonal to the money bands.
 *   • Data-independent (SDD §H): keys on a structured state flag, not a
 *     free-text re-classification — the genuinely deterministic net, not a
 *     probabilistic detector.
 *   • Fail-SAFE when the flag is absent (the adopter-seam direction of
 *     `requireTenantBinding`/ownership): a host that has not yet wired the
 *     disambiguation sees the SAFE posture (confirm a real-money mutation),
 *     never a silent bypass. Only an explicit `true` lets the amend proceed.
 *   • Scoped to `order.amend.add_item` ONLY — `update_qty`/`remove_item`/
 *     `request` are not the adjacent pair the registry names and are left to
 *     their existing verdicts; widening would be over-blocking, not the §O#10
 *     fix.
 */
const requireAmendItemDisambiguation: OrderGuard = (envelope, state) => {
  if (envelope.kind !== "order.amend.add_item") return null
  if (state.ctx.amendItemConfirmed === true) return null
  return decisionRequestConfirmation(
    "Isso adiciona um item a um pedido que já foi feito (não ao carrinho). Confirma a alteração no pedido?",
    [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        rule: "adjacent_amend_requires_confirmation",
        kind: envelope.kind,
      }),
    ],
  )
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

const EXECUTABLE_AMEND_KINDS: ReadonlySet<string> = new Set([
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
])

const executeAmend: OrderGuard = (envelope) => {
  if (!EXECUTABLE_AMEND_KINDS.has(envelope.kind)) return null
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

/**
 * Validate the rating range on `order.review.submit`. CLAUDE.md
 * positions the kernel as a second authority — even though the wire
 * schema enforces 1–5 integer at the LLM tool boundary, the policy
 * REFUSEs an out-of-range rating so a future caller that skipped the
 * wire schema cannot reach Prisma with `rating: 99`.
 *
 * Empty / null comment is fine. The kernel-emitted basis is
 * `RULE_VIOLATED` — the wire schema's rejection short-circuits before
 * this guard sees most LLM proposals.
 */
const validateReviewRating: OrderGuard = (envelope) => {
  if (envelope.kind !== "order.review.submit") return null
  const payload = envelope.payload as { rating?: unknown }
  const rating = payload.rating
  if (
    typeof rating !== "number" ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) {
    return decisionRefuse(refuseInvalidRating(rating), [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "review_rating_out_of_range",
        rating: typeof rating === "number" ? rating : null,
      }),
    ])
  }
  return null
}

// ── W5-2 EXECUTE producers ──────────────────────────────────────────────

const W5_EXECUTE_KINDS: ReadonlySet<string> = new Set([
  "order.cart.sync",
  "order.pix.details.set",
  "order.address.change",
  "order.type.switch",
  "order.review.submit",
  "order.reorder",
  "order.projection.create",
  "order.status.transition",
  "order.status.reconcile",
])

const executeW5Kinds: OrderGuard = (envelope) => {
  if (!W5_EXECUTE_KINDS.has(envelope.kind)) return null
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
    // BKL-090 — after requireOrderIdForMutation so a missing order REFUSEs
    // `no_order` first; this guard then gates transition LEGALITY/terminality.
    requireLegalStatusTransition,
    requireCancellable,
    requireAmendable,
    requireCartItemsForCheckout,
    requireSlotsFilledForCheckout,
    deferOnPendingPix,
  ],
  authGuards: [requireTenantBindingGuard, requireAuthenticated, enforceOrderOwnership, requireCheckoutEligibility],
  taint: orderTaintPolicy,
  business: [
    requireExplicitAllergens,
    validateQuantity,
    clampUpdateToStockCap,
    validatePaymentMethod,
    refuseAmountAboveCap,
    // BKL-036 (J015) — paid-state cancel gating BEFORE escalateLargeCancel so
    // the PAID cancel path is owned by gatePaidCancel in full (ESCALATE high /
    // REQUEST_CONFIRMATION low); escalateLargeCancel then governs the UNPAID
    // large-cancel escalation unchanged.
    gatePaidCancel,
    escalateLargeCancel,
    confirmLargeTicket,
    // FE-T05 — after requireLegalStatusTransition (stateGuards) already REFUSEd
    // an illegal/terminal transition; a legal-but-GUESSED target still needs
    // explicit confirmation before it can execute.
    requireConfirmationOnGroundedStatusTransition,
    validateReviewRating,
    refuseCardPanInPix,
    redactPiiInPix,
    requireAmendItemDisambiguation,
    executeCartOps,
    executeCheckout,
    executeCancel,
    executeAmend,
    executeNoteAdd,
    executeW5Kinds,
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
