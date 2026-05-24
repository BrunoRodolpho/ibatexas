/**
 * @ibatexas/pack-orders — domain types.
 *
 * IbateXas's first first-party Pack: governs the checkout / order
 * lifecycle. Mirrors the `pack-payments-pix` layout exactly so subsequent
 * Packs (pack-reservations, pack-whatsapp, pack-customer-onboarding) can
 * template off this one.
 *
 * Authoritative intent vocabulary: `docs/adjudicate-migration/governance/
 * 01-intent-taxonomy.md` §"Domain: order". This Pack does NOT redeclare
 * payment.pix.regenerate — that intent belongs in the `payment` domain
 * and is fielded by `pack-payments-pix` (or a future first-party
 * pack-payments). PIX is composed here only as a DEFER signal for
 * `order.checkout.create`.
 *
 * # Intent surface (governance §"order")
 *
 *   - order.cart.ensure       — UNTRUSTED. Get-or-create cart for the customer.
 *   - order.item.add          — UNTRUSTED. Add line item. SAFETY: allergens MUST
 *                                be an explicit string[] (CLAUDE.md rule #1).
 *   - order.item.update       — UNTRUSTED. Update quantity. REWRITE-clamp to
 *                                stock cap if exceeded.
 *   - order.item.remove       — UNTRUSTED. Remove line item.
 *   - order.coupon.apply      — UNTRUSTED. Apply promotion code to cart.
 *   - order.checkout.create   — UNTRUSTED. Finalize cart → order. Composes
 *                                createPixPendingDeferGuard against PIX flow.
 *   - order.cancel            — UNTRUSTED. Customer-initiated cancel.
 *   - order.cancel.system     — SYSTEM-only. Cron / subscriber auto-cancel
 *                                (e.g., stale / pix_expired).
 *   - order.amend.request     — UNTRUSTED. Modify a placed order within the
 *                                amend window.
 *   - order.note.add          — UNTRUSTED. Add a note to an order.
 *
 * The kinds in this Pack derive from the master taxonomy; if you need to
 * add a new kind, update the taxonomy doc FIRST.
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

/**
 * W5-2 expansion: adds the lifecycle / projection / granular-amend
 * kinds the taxonomy enumerates. See audit 07 §"Domain: order" and
 * `docs/adjudicate-migration/remediation/W3-INTENT-GAPS.md`.
 *
 * # Kinds added in W5-2
 *
 *   - `order.cart.sync`            — UNTRUSTED. Bulk sync of cart line items.
 *   - `order.pix.details.set`      — UNTRUSTED. Save PIX billing details onto
 *                                     the cart. PII payload.
 *   - `order.address.change`       — UNTRUSTED. Change delivery address on
 *                                     a placed order.
 *   - `order.type.switch`          — UNTRUSTED. Switch fulfillment type
 *                                     (delivery / takeout).
 *   - `order.review.submit`        — UNTRUSTED. Customer reviews an order.
 *   - `order.reorder`              — UNTRUSTED. Re-order a previous purchase
 *                                     (composite — produces multiple
 *                                     `order.item.add` envelopes inside the
 *                                     executor).
 *   - `order.projection.create`    — SYSTEM. Initial projection row for an
 *                                     order on cart-intelligence subscriber.
 *   - `order.status.transition`    — SYSTEM/TRUSTED. Direct status flip
 *                                     (admin advance / job mark stale).
 *   - `order.status.reconcile`     — SYSTEM. Reconciliation from a
 *                                     subscriber event (cart-intelligence).
 *   - `order.amend.add_item`       — UNTRUSTED. Granular amend — add a line.
 *   - `order.amend.update_qty`     — UNTRUSTED. Granular amend — change qty.
 *   - `order.amend.remove_item`    — UNTRUSTED. Granular amend — drop a line.
 */
export type OrderIntentKind =
  | "order.cart.ensure"
  | "order.item.add"
  | "order.item.update"
  | "order.item.remove"
  | "order.cart.sync"
  | "order.coupon.apply"
  | "order.checkout.create"
  | "order.pix.details.set"
  | "order.cancel"
  | "order.cancel.system"
  | "order.amend.request"
  | "order.amend.add_item"
  | "order.amend.update_qty"
  | "order.amend.remove_item"
  | "order.address.change"
  | "order.type.switch"
  | "order.note.add"
  | "order.review.submit"
  | "order.reorder"
  | "order.projection.create"
  | "order.status.transition"
  | "order.status.reconcile"

// ── Payloads ────────────────────────────────────────────────────────────

export interface OrderCartEnsurePayload {
  readonly cartId?: string
}

/**
 * Adding an item to the cart. **Safety-critical** per CLAUDE.md rule #1:
 * `allergens` is an explicit string array — never inferred from product
 * name or description. The Pack REFUSEs the intent if `allergens` is
 * absent, non-array, or contains a non-string element.
 */
export interface OrderItemAddPayload {
  readonly cartId: string
  readonly variantId: string
  readonly quantity: number
  /** Explicit list of allergens for this line. Required and load-bearing. */
  readonly allergens: ReadonlyArray<string>
}

export interface OrderItemUpdatePayload {
  readonly cartId: string
  readonly itemId: string
  readonly quantity: number
}

export interface OrderItemRemovePayload {
  readonly cartId: string
  readonly itemId: string
}

export interface OrderCouponApplyPayload {
  readonly cartId: string
  readonly code: string
}

/**
 * Finalize cart into an order. `paymentMethod` is the user-selected
 * settlement channel; `pixDetails` is PII and redacted at audit time
 * (per `governance/05-audit-replay-requirements.md`).
 */
export interface OrderCheckoutCreatePayload {
  readonly cartId: string
  readonly paymentMethod: "pix" | "card" | "cash"
  readonly pixDetails?: {
    readonly name: string
    readonly email: string
    readonly cpf: string
  }
}

export interface OrderCancelPayload {
  readonly orderId: string
  readonly reason?: string
}

export interface OrderCancelSystemPayload {
  readonly orderId: string
  readonly reason: "stale" | "pix_expired"
}

export interface OrderAmendRequestPayload {
  readonly orderId: string
  readonly changes: ReadonlyArray<{
    readonly op: "add" | "remove" | "update"
    readonly variantId?: string
    readonly itemId?: string
    readonly quantity?: number
  }>
}

export interface OrderNoteAddPayload {
  readonly orderId: string
  readonly body: string
  readonly isInternal?: boolean
}

// ── W5-2 payloads ───────────────────────────────────────────────────────

export interface OrderCartSyncPayload {
  readonly cartId: string
  readonly items: ReadonlyArray<{
    readonly variantId: string
    readonly quantity: number
    /** Explicit allergens per line — CLAUDE.md rule #1. */
    readonly allergens: ReadonlyArray<string>
  }>
}

/**
 * PIX billing details — PII payload. The Pack does not log raw values;
 * the audit redactor handles redaction before sink emit.
 */
export interface OrderPixDetailsSetPayload {
  readonly cartId: string
  readonly name: string
  readonly email: string
  readonly cpf: string
}

export interface OrderAddressChangePayload {
  readonly orderId: string
  readonly address: {
    readonly street: string
    readonly number?: string
    readonly complement?: string
    readonly neighborhood?: string
    readonly city: string
    readonly state: string
    readonly zip: string
  }
}

export interface OrderTypeSwitchPayload {
  readonly orderId: string
  readonly newType: "delivery" | "takeout"
  /**
   * audit-2026-05-24 P2-3: optional non-collapsed HTTP vocabulary
   * captured for audit fidelity. Pack-orders policies adjudicate on
   * `newType` (binary delivery|takeout); adopters whose HTTP surface
   * distinguishes `pickup` vs `dine_in` (both collapse to `takeout`
   * here) can record the operator-visible vocab via this field so the
   * audit record preserves what the customer actually asked for.
   *
   * Ignored by the pack's guards — descriptive only.
   */
  readonly httpVocab?: "delivery" | "pickup" | "dine_in"
}

export interface OrderReviewSubmitPayload {
  readonly orderId: string
  readonly productId: string
  readonly rating: number
  readonly comment?: string
}

export interface OrderReorderPayload {
  readonly previousOrderId: string
  readonly paymentMethod: "pix" | "card" | "cash"
}

export interface OrderProjectionCreatePayload {
  readonly orderId: string
  readonly customerId: string
  readonly totalCentavos: number
  readonly source: "checkout" | "amendment" | "system_seed"
}

export interface OrderStatusTransitionPayload {
  readonly orderId: string
  readonly newStatus: string
  readonly expectedVersion?: number
  readonly actor: "admin" | "system" | "customer"
  readonly actorId?: string
  readonly reason?: string
}

export interface OrderStatusReconcilePayload {
  readonly orderId: string
  readonly newStatus: string
  readonly source: "payment_lifecycle" | "cart_intelligence" | "webhook"
}

/**
 * Granular amend payloads. The legacy `order.amend.request` payload
 * groups all changes; the granular variants let pack-orders adjudicate
 * each change in isolation (per W3 P0-3 recommendation).
 */
export interface OrderAmendAddItemPayload {
  readonly orderId: string
  readonly variantId: string
  readonly quantity: number
  /** Explicit allergens — CLAUDE.md rule #1. */
  readonly allergens: ReadonlyArray<string>
}

export interface OrderAmendUpdateQtyPayload {
  readonly orderId: string
  readonly itemId: string
  readonly quantity: number
}

export interface OrderAmendRemoveItemPayload {
  readonly orderId: string
  readonly itemId: string
}

/**
 * Discriminated payload union — typed by `kind`. Guards narrow via
 * `envelope.kind` and may cast `envelope.payload` to the matching
 * member; payload contracts are validated by the guards in
 * `./policies.ts` and by the wire schema upstream.
 */
export type OrderPayload =
  | OrderCartEnsurePayload
  | OrderItemAddPayload
  | OrderItemUpdatePayload
  | OrderItemRemovePayload
  | OrderCartSyncPayload
  | OrderCouponApplyPayload
  | OrderCheckoutCreatePayload
  | OrderPixDetailsSetPayload
  | OrderCancelPayload
  | OrderCancelSystemPayload
  | OrderAmendRequestPayload
  | OrderAmendAddItemPayload
  | OrderAmendUpdateQtyPayload
  | OrderAmendRemoveItemPayload
  | OrderAddressChangePayload
  | OrderTypeSwitchPayload
  | OrderNoteAddPayload
  | OrderReviewSubmitPayload
  | OrderReorderPayload
  | OrderProjectionCreatePayload
  | OrderStatusTransitionPayload
  | OrderStatusReconcilePayload

// ── Context (per-turn caller identity / channel surface) ────────────────

/**
 * Per-turn context the planner consumes. Mirrors the relevant slice of
 * IbateXas's `OrderContext` (in `@ibatexas/llm-provider/machine/types.ts`)
 * but is structurally independent — the Pack must not import the
 * llm-provider state shape (Pack is upstream of consumers).
 */
export interface OrderContext {
  readonly channel: "whatsapp" | "web"
  readonly customerId: string | null
  readonly cartId: string | null
  readonly orderId: string | null
}

// ── State (per-session snapshot the kernel adjudicates against) ─────────

/**
 * Per-session state shape. The Pack only requires what its policies
 * inspect; adopters embed this inside their own session context. The
 * legacy `orderPolicyBundle` reads `state.ctx` — the embedded
 * `OrderContext` here is the structural equivalent.
 *
 * `paymentMethod` / `paymentStatus` are reads from the adopter's payment
 * substrate. When `paymentMethod === "pix"` and `paymentStatus` is not
 * in the settled set, `order.checkout.create` DEFERs via the
 * `createPixPendingDeferGuard` factory composed in `./policies.ts`.
 */
export interface OrderState {
  readonly ctx: OrderContext & {
    readonly items?: ReadonlyArray<{
      readonly variantId: string
      readonly quantity: number
      readonly priceInCentavos: number
      /** Per-line stock cap — drives REWRITE-clamp in order.item.update. */
      readonly stockCap?: number
    }>
    readonly fulfillment?: "pickup" | "delivery" | null
    readonly paymentMethod?: "pix" | "card" | "cash" | null
    readonly paymentStatus?: string | null
    readonly totalInCentavos?: number
    /** Marker recorded after a successful cancel — guards subsequent cancels. */
    readonly lastAction?: "cancelled" | "amended" | null
  }
}

// ── Taint policy ────────────────────────────────────────────────────────

/**
 * Customer-initiated kinds tolerate UNTRUSTED (the LLM proposes them on
 * the user's behalf; the policy decides). `order.cancel.system` is the
 * only system-only kind in this Pack — cron / subscriber callers (e.g.,
 * `stale-order-checker.ts`) emit it with TRUSTED taint; the LLM must
 * never be able to forge a system auto-cancel.
 *
 * Note that the LEGACY `orderPolicyBundle` mapped `payment.send` and
 * `refund.issue` to TRUSTED; those kinds belong to the `payment` domain
 * (governance §"Domain: payment") and are NOT in this Pack's surface.
 * Future `@ibatexas/pack-payments` carries that mapping.
 */
export const orderTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [
    "order.cancel.system",
    "order.projection.create",
    "order.status.reconcile",
  ],
  userMinimum: "UNTRUSTED",
})

// ── Business thresholds (centavos — CLAUDE.md rule #2) ──────────────────

/**
 * REQUEST_CONFIRMATION trigger for large-ticket checkouts. R$ 1.000 by
 * default — orders at or above this prompt the user for explicit
 * confirmation before EXECUTE. Centavos integer.
 */
export const CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS = 100_000

/**
 * ESCALATE trigger for refund-equivalent flows in the order domain — a
 * customer-initiated `order.cancel` AFTER the order has shipped (i.e.,
 * `lastAction === "amended"` and a paid-status sentinel) escalates to
 * a human. Below this threshold, the cancel is REFUSEd by the
 * cancel-eligibility guard; above it, the escalate-on-shipped guard
 * takes precedence.
 */
export const ESCALATE_CANCEL_AMOUNT_CENTAVOS = 100_000

// ── Domain constants ────────────────────────────────────────────────────

/**
 * Re-exported for adopter convenience. The Pack's `order.checkout.create`
 * DEFERs on this signal (delegated via `createPixPendingDeferGuard` from
 * `@adjudicate/pack-payments-pix`) until the PIX provider's webhook
 * resumes the deferred intent.
 */
export { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix"

/**
 * Statuses the adopter's payment substrate uses to mark a PIX charge as
 * settled — `paid`, `captured`, `confirmed`. Mirrors the set already
 * used in IbateXas's legacy `order-policy-bundle.ts` so the migration
 * preserves byte-identical decisions.
 */
export const ORDER_PIX_CONFIRMED_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "captured",
  "confirmed",
])
