// order-projection-policy.ts — domain-internal PolicyBundle for the
// system-side OrderProjection lifecycle operations.
//
// Scope (intent kinds covered):
//   - order.projection.create           — SYSTEM. Initial projection from
//                                         a Medusa order.placed event.
//   - order.status.transition           — STAFF/SYSTEM/CUSTOMER. Status
//                                         transition with optimistic
//                                         concurrency. The canonical kind
//                                         (per governance taxonomy §"order").
//   - order.status.reconcile            — SYSTEM. Subscriber-driven event
//                                         reconciliation. SYSTEM-only.
//   - order.type.switch                 — CUSTOMER. Switch delivery type
//                                         (consolidated from the rogue
//                                         packages/tools/src/cart/
//                                         switch-order-type.ts writer).
//   - order.address.change              — CUSTOMER. Change shipping
//                                         address (consolidated from the
//                                         rogue change-delivery-address.ts
//                                         writer).
//
// `order.note.add` is NOT covered here — it lives in @ibatexas/pack-orders
// (the LLM-proposable canonical Pack). Service callers route note-add
// through pack-orders' policy directly.
//
// Why split:
//
//   - @ibatexas/pack-orders is the LLM-facing Pack (governs intents the LLM
//     proposes — cart, checkout, item add/update/remove, cancel, note,
//     amend).
//
//   - The 5 kinds above are SYSTEM-side projection-lifecycle ops. They do
//     not have an LLM-proposable analogue and do not belong in the LLM
//     planner surface (the LLM has no business calling
//     `order.status.reconcile`). Keeping them out of pack-orders preserves
//     the Pack's contract surface for the planner.
//
//   - The `order.type.switch` and `order.address.change` are
//     UNTRUSTED-tolerant (LLM-proposable via tools); the auth gate is
//     enforced by the calling tool, which checks `ctx.customerId` /
//     ownership before building the envelope. The Pack's auth surface
//     handles the cart/order-life-cycle authoritatively; these are
//     post-placement amendments that share the same auth shape (which is
//     a tools-layer responsibility, not a Pack-policy concern at this
//     consolidation stage).
//
// Backwards-compat decision (D8): this policy and its envelope-typed
// service methods are ADDED ALONGSIDE the legacy bare-arg methods.
// Existing callers continue to work. Tasks 12-14, 16, 17 migrate to the
// envelope-typed entry points incrementally.

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

export type OrderProjectionIntentKind =
  | "order.projection.create"
  | "order.status.transition"
  | "order.status.reconcile"
  | "order.type.switch"
  | "order.address.change"

export interface OrderProjectionCreatePayload {
  readonly orderId: string
  readonly displayId: number
  readonly customerId: string | null
  readonly fulfillmentStatus: string
  readonly paymentStatus: string | null
  /** Centavos integer per CLAUDE.md rule #2. */
  readonly totalInCentavos: number
}

export interface OrderStatusTransitionPayload {
  readonly orderId: string
  readonly newStatus: string
  readonly actor: "admin" | "system" | "customer"
  readonly actorId?: string
  readonly reason?: string
  readonly expectedVersion?: number
}

export interface OrderStatusReconcilePayload {
  readonly orderId: string
  readonly newStatus: string
  /** Required — projection ignores reconcile when stale. */
  readonly eventVersion: number
  readonly actor?: "admin" | "system" | "customer"
  readonly actorId?: string
}

export interface OrderTypeSwitchPayload {
  readonly orderId: string
  readonly newType: "delivery" | "pickup" | "dine_in"
  readonly customerId: string
}

export interface OrderAddressChangePayload {
  readonly orderId: string
  readonly customerId: string
  readonly address: {
    readonly address1: string
    readonly address2?: string
    readonly city: string
    readonly state: string
    readonly postalCode: string
    readonly neighborhood?: string
  }
}

export type OrderProjectionPayload =
  | OrderProjectionCreatePayload
  | OrderStatusTransitionPayload
  | OrderStatusReconcilePayload
  | OrderTypeSwitchPayload
  | OrderAddressChangePayload

// ── State ──────────────────────────────────────────────────────────────────

/**
 * Per-call state snapshot the kernel adjudicates against. Pulled from the
 * projection row at the start of the service method. SYSTEM-side mutations
 * inspect minimal fields (the policy mostly relies on the taint + actor
 * gate rather than complex state guards — the imperative service code
 * still owns transition validity).
 */
export interface OrderProjectionState {
  readonly ctx: {
    /** Whether the projection row exists (false → create path). */
    readonly exists: boolean
    /** Current status if `exists`. */
    readonly currentStatus?: string
    /** Current version if `exists` (drives optimistic concurrency outside the kernel). */
    readonly version?: number
    /** Customer ID on the projection (for ownership check on customer-driven ops). */
    readonly customerId?: string | null
    /** Current delivery type (for switch-type idempotency / refuse-no-op). */
    readonly currentDeliveryType?: string | null
  }
}

// ── Taint policy ───────────────────────────────────────────────────────────

/**
 * Reconcile is SYSTEM-only — only subscribers / jobs may emit it. Create
 * is SYSTEM-only — only the order.placed subscriber may emit it. The other
 * three (status.transition, type.switch, address.change) tolerate
 * UNTRUSTED at the taint level — the caller (admin route, customer tool,
 * cron) injects ownership / role checks before the envelope is built.
 */
export const orderProjectionTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["order.projection.create", "order.status.reconcile"],
  userMinimum: "UNTRUSTED",
})

// ── Guards ────────────────────────────────────────────────────────────────

type ProjectionGuard = Guard<
  OrderProjectionIntentKind,
  OrderProjectionPayload,
  OrderProjectionState
>

/**
 * Refuse if status-transition / type-switch / address-change is requested
 * against a non-existent projection. Reconcile + create handle existence
 * internally (reconcile returns null on miss; create is the create itself).
 */
const requireProjectionExists: ProjectionGuard = (envelope, state) => {
  if (
    envelope.kind === "order.projection.create" ||
    envelope.kind === "order.status.reconcile"
  ) {
    return null
  }
  if (state.ctx.exists) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "order.projection.not_found",
      "Pedido não encontrado.",
    ),
    [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "projection_not_found",
      }),
    ],
  )
}

/**
 * Customer-driven amendments (type.switch, address.change) must come from
 * the registered owner. The service caller passes `customerId` on the
 * payload; the kernel checks it against the projection's `customerId`
 * snapshot. This is a defense-in-depth check — the tool layer already
 * gates on `ctx.customerId === order.customerId`.
 */
const requireCustomerOwnership: ProjectionGuard = (envelope, state) => {
  if (
    envelope.kind !== "order.type.switch" &&
    envelope.kind !== "order.address.change"
  ) {
    return null
  }
  const payload = envelope.payload as
    | OrderTypeSwitchPayload
    | OrderAddressChangePayload
  if (!state.ctx.customerId) return null
  if (state.ctx.customerId === payload.customerId) return null
  return decisionRefuse(
    refuse(
      "AUTH",
      "order.projection.not_owner",
      "Você não tem permissão para alterar este pedido.",
    ),
    [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, {
        reason: "ownership_mismatch",
      }),
    ],
  )
}

/**
 * No-op refuse: type.switch where currentDeliveryType === newType. Avoids
 * a needless version bump.
 */
const refuseTypeSwitchNoOp: ProjectionGuard = (envelope, state) => {
  if (envelope.kind !== "order.type.switch") return null
  const payload = envelope.payload as OrderTypeSwitchPayload
  if (!state.ctx.currentDeliveryType) return null
  if (state.ctx.currentDeliveryType !== payload.newType) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "order.projection.type_unchanged",
      "Pedido já é deste tipo.",
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "type_switch_no_op",
        currentType: state.ctx.currentDeliveryType,
      }),
    ],
  )
}

/**
 * EXECUTE producers — explicit positive matches per default-REFUSE
 * polarity. Each kind needs one positive guard; the imperative service
 * code owns the actual transition validity (state machine check,
 * optimistic concurrency).
 */
const executeAll: ProjectionGuard = (envelope) => {
  switch (envelope.kind) {
    case "order.projection.create":
    case "order.status.transition":
    case "order.status.reconcile":
    case "order.type.switch":
    case "order.address.change":
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

export const orderProjectionPolicyBundle: PolicyBundle<
  OrderProjectionIntentKind,
  OrderProjectionPayload,
  OrderProjectionState
> = {
  stateGuards: [requireProjectionExists, refuseTypeSwitchNoOp],
  authGuards: [requireCustomerOwnership],
  taint: orderProjectionTaintPolicy,
  business: [executeAll],
  default: "REFUSE",
}
