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
 *   - order.amend.request     — UNTRUSTED. Modify a placed order within the
 *                                amend window.
 *   - order.note.add          — UNTRUSTED. Add a note to an order.
 *
 * The kinds in this Pack derive from the master taxonomy; if you need to
 * add a new kind, update the taxonomy doc FIRST.
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"
import { MONEY_BAND_1000_CENTAVOS } from "@ibatexas/types"

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
  | "order.fiscal.emit"

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

/**
 * NEW-014 — `order.fiscal.emit` (SYSTEM-only). Emit the fiscal document
 * (NFC-e/NFe) for a delivered order. The subscriber (PR2) builds this from the
 * order.status_changed→delivered event with a system actor; the resolver stamps
 * the order state (fulfillmentStatus + fiscalEmitAttempts) the policy reads.
 */
export interface OrderFiscalEmitPayload {
  readonly orderId: string
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
  | OrderFiscalEmitPayload
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
    /**
     * The tenant this request operates on (AuthReviewer-009 / RC-A1 D-12).
     * Single-tenant today — the conductor resolver supplies "ibatexas"; the
     * `requireTenantBinding` authGuard REFUSEs a mismatch. Optional: absent on
     * the gateway/legacy path, where the guard is a no-op (lenient).
     */
    readonly tenantId?: string
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
    /** Order fulfillment status — drives the kernel cancel point-of-no-return
     *  guard (mirrors the route-layer canPerformAction rule). NEW-014 also
     *  reads it for the fiscal-eligible gate on `order.fiscal.emit`. */
    readonly fulfillmentStatus?: string | null
    /**
     * NEW-014 — how many fiscal-emit attempts this order already had (the
     * adopter supplies it from the persisted fiscal record / a counter). The
     * bounded-retry guard REFUSEs `order.fiscal.emit` at/above the cap so a
     * rejecting SEFAZ is never hammered. Absent ⇒ 0 (first attempt).
     */
    readonly fiscalEmitAttempts?: number
    /**
     * SDD §O#10 (adjacent-type confident-wrong) disambiguation signal.
     *
     * `order.amend.add_item` (add a line to a **placed order** — real money,
     * post-checkout) and `order.item.add` (a **cart** op — low stakes,
     * pre-checkout) are adjacent intents. A planner mis-frame toward the
     * higher-stakes amend passes every existing gate (capability catalog,
     * outcome, P2, P4), so a wrong-but-adjacent real-money action would
     * EXECUTE and narrate truthfully (the one clause the §2/§C guarantee line
     * names as a residual). The host sets this `true` ONLY once the user's
     * intent to amend a *placed order* (rather than build a cart) has been
     * deterministically disambiguated/confirmed; `requireAmendItemDisambiguation`
     * (`./policies.ts`) degrades the amend to `REQUEST_CONFIRMATION` whenever it
     * is absent/false, so the adjacent mis-frame fails SAFE instead of silently
     * mutating a placed order. Data-independent (a structured flag, not a
     * free-text re-classification — SDD §H); lenient when absent so a host that
     * has not yet wired the disambiguation sees the SAFE posture (confirm), not
     * a bypass. Orthogonal to the Inv 11 money bands — it keys on the amend
     * KIND, never on an amount.
     */
    readonly amendItemConfirmed?: boolean
    /**
     * FE-T05 (Language Engine, HydratedIntentIR provenance) — how the target
     * order for `order.status.transition` was resolved:
     *   - `"authoritative"` — the staff gave an EXPLICIT reference (a display
     *     number or a customer name; BKL-089 resolution).
     *   - `"grounded"` — no reference was given; the host auto-resolved "the
     *     most recent active order" (a GUESS). `requireConfirmationOnGrounded
     *     StatusTransition` (`./policies.ts`) forces a REQUEST_CONFIRMATION
     *     whenever this is `"grounded"` — a guessed target must never
     *     silently EXECUTE a kitchen advance / cancel.
     * Absent when no order resolved at all (requireOrderIdForMutation REFUSEs
     * first) or for any other kind (inert everywhere else).
     */
    readonly orderResolutionTrust?: "authoritative" | "grounded"
    /**
     * FE-T05 review (MAJOR-2) — the resolved order's DISPLAY number, present
     * whenever `orderResolutionTrust === "grounded"` (an auto-resolved
     * guess). `requireConfirmationOnGroundedStatusTransition` (`./policies.ts`)
     * names the order in its confirmation prompt with this — a staff member
     * confirming a GUESSED target must be able to recognize (and reject) a
     * wrong one. Absent for any other resolution path / kind.
     */
    readonly displayId?: number
  }
}

// ── Taint policy ────────────────────────────────────────────────────────

/**
 * Customer-initiated kinds tolerate UNTRUSTED (the LLM proposes them on
 * the user's behalf; the policy decides). The system-only kinds
 * (`order.projection.create`, `order.status.reconcile`) require TRUSTED
 * taint; the LLM must never be able to forge them. (The former system
 * auto-cancel kind `order.cancel.system` was retired as a dead duplicate —
 * BKL-177: `stale-order-checker.ts` drives compensation cancels via
 * `order.status.transition`→CANCELED, not a bespoke system-cancel kind.)
 *
 * Note that the LEGACY `orderPolicyBundle` mapped `payment.send` and
 * `refund.issue` to TRUSTED; those kinds belong to the `payment` domain
 * (governance §"Domain: payment") and are NOT in this Pack's surface.
 * Future `@ibatexas/pack-payments` carries that mapping.
 */
export const orderTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [
    "order.projection.create",
    "order.status.reconcile",
    // NEW-014 — fiscal emission is SYSTEM-only; the LLM must never forge it.
    "order.fiscal.emit",
  ],
  userMinimum: "UNTRUSTED",
})

// ── Business thresholds (centavos — CLAUDE.md rule #2) ──────────────────

/**
 * REQUEST_CONFIRMATION trigger for large-ticket checkouts. R$ 1.000 by
 * default — orders at or above this prompt the user for explicit
 * confirmation before EXECUTE. Centavos integer.
 *
 * FE-T02: single-sourced from `@ibatexas/types`' `MONEY_BAND_1000_CENTAVOS`
 * — the same boundary `@ibatexas/pack-payments`' refund-escalate ladder
 * reads (with its own, currently-divergent, `>` comparator).
 */
export const CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS = MONEY_BAND_1000_CENTAVOS

/**
 * ESCALATE trigger for refund-equivalent flows in the order domain — a
 * customer-initiated `order.cancel` AFTER the order has shipped (i.e.,
 * `lastAction === "amended"` and a paid-status sentinel) escalates to
 * a human. Below this threshold, the cancel is REFUSEd by the
 * cancel-eligibility guard; above it, the escalate-on-shipped guard
 * takes precedence.
 *
 * The same R$1000 boundary as `MONEY_BAND_1000_CENTAVOS` in
 * `@ibatexas/types`, structurally a separate band (order.cancel, not
 * checkout) but numerically identical — FE-D01 single-sources the VALUE
 * so it can never drift from the checkout / refund ladders. Its comparator
 * is already the canonical `>=` (`escalateLargeCancel` in `./policies.ts`
 * uses `createEscalateGuard({ comparator: ">=" })`), consistent with
 * FE-T03/D2's exact-R$1000-escalates decision — no comparator flip needed.
 */
export const ESCALATE_CANCEL_AMOUNT_CENTAVOS = MONEY_BAND_1000_CENTAVOS

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
