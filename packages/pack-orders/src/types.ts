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
 *   - `order.reorder.request`      — UNTRUSTED. LE2-021. ASK to repeat the last
 *                                     order. The governance ANCHOR of the
 *                                     `workflow.orders.reorder-last` workflow
 *                                     and nothing else: it carries the
 *                                     unconditional whole-workflow CONFIRM
 *                                     (`confirmReorderLast`) and the no-history
 *                                     REFUSE, while `order.reorder` above does
 *                                     the actual rebuilding as a
 *                                     workflow-scoped activity. Two kinds
 *                                     because the ASK and the ACT need
 *                                     different access classes: the ask is
 *                                     parse-reachable (a workflow's selection
 *                                     envelope is minted from a parse), the act
 *                                     never is.
 *   - `order.coupon.swap.request`  — UNTRUSTED. LE2-023. ASK to cancel a placed
 *                                     order and rebuild it with a coupon
 *                                     applied. The governance ANCHOR of the
 *                                     `workflow.orders.swap-for-coupon`
 *                                     workflow, on the same ASK/ACT split as
 *                                     `order.reorder.request` above: it carries
 *                                     the whole-workflow CONFIRM
 *                                     (`confirmSwapForCoupon`, which states the
 *                                     order amount, the refund consequence and
 *                                     the new total) while the route's own
 *                                     `order.cancel` / `order.reorder` /
 *                                     `order.coupon.apply` activities each do
 *                                     one governed piece of the work.
 *   - `order.cancel.request`       — UNTRUSTED. LE2-024. ASK to cancel a placed
 *                                     order. The governance ANCHOR of the
 *                                     `workflow.orders.paid-cancel` workflow, on
 *                                     the same ASK/ACT split as the two anchors
 *                                     above — with one difference that is the
 *                                     whole point of that ticket: the ACT it
 *                                     fronts is `order.cancel`, which ALREADY
 *                                     exists as a directly-parseable capability.
 *                                     So `confirmPaidCancel` does not author a
 *                                     new question; it asks `gatePaidCancel`'s
 *                                     own, through the shared
 *                                     `paidCancelConfirmText`, and a parity suite
 *                                     pins the two renders byte-identical.
 *   - `order.coupon.adjust`        — DECLARED AND UNEXECUTABLE. LE2-023. Apply a
 *                                     coupon to an ALREADY-PLACED order by
 *                                     adjusting its price. It is workflow-scoped
 *                                     (no parse can reach it) AND no guard in
 *                                     this bundle produces EXECUTE for it, so
 *                                     the kernel's default REFUSE is the only
 *                                     verdict it can ever receive. It exists so
 *                                     the swap-for-coupon workflow's
 *                                     `coupon_on_placed_order` policy branch can
 *                                     NAME a real capability while shipping
 *                                     closed — see that workflow's route and
 *                                     `WORKFLOW_POLICY_SWITCHES`. Opening the
 *                                     branch is a catalog edit; making it RUN
 *                                     additionally requires a pack policy change
 *                                     here, which is the second of the two locks.
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
  | "order.reorder.request"
  | "order.coupon.swap.request"
  | "order.cancel.request"
  | "order.coupon.adjust"
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
  /**
   * BKL-103 — the PROPOSER stamp: the authenticated id of whoever REQUESTED this
   * cancel (the customer, on both the HTTP and conversational planes). Identity
   * class — stamped by the host's authenticated write side, NEVER model-fillable
   * (`actorId` is in `FORBIDDEN_EXTRACTION_FIELD_NAMES`, so no extraction schema
   * can expose it), mirroring `OrderStatusTransitionPayload.actorId` and
   * `PaymentRefundIssuePayload.actorId`.
   *
   * It exists because `order.cancel` is a RESUMABLE escalation kind
   * (`ESCALATION_RESUMABLE_KINDS`, apps/api escalation-park-store.ts): the
   * escalate-band self-approve overlay in `./policies.ts` compares
   * `approval.approverId !== payload.actorId`, so WITHOUT this stamp the
   * comparand is `undefined`, the comparison is trivially true, and the deepest
   * separation-of-duty gate silently degrades (the BKL-113 hazard). Optional so
   * a legacy/unstamped caller still type-checks — but an unstamped payload
   * cannot convert an ESCALATE (the overlay requires a non-empty comparand), so
   * absence fails SAFE (the escalation simply stays escalated).
   */
  readonly actorId?: string
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

/**
 * LE2-021 — the reorder-last ASK (`order.reorder.request`).
 *
 * It carries NO AUTHORED FIELDS, and that absence is the design rather than an
 * omission. The one value this act needs — WHICH previous order — is the one
 * value a language model must never supply: an order id it reported would be
 * indistinguishable from an order id it invented, and the customer would be
 * shown a confirmation for someone else's basket or for nothing at all. So the
 * id never rides the payload. `resolveAndAssemble` projects the customer's last
 * order from an OWNER-SCOPED read and stamps it on `OrderState.ctx`
 * (`previousOrderId` and friends below), where `confirmReorderLast` reads it to
 * author the confirm sentence — see that guard in `./policies.ts`.
 *
 * The single optional field is written by the WORKFLOW RUNTIME, never by a
 * parse: it is the instance handle that has to survive the confirm park (see
 * `WORKFLOW_INSTANCE_PAYLOAD_KEY` in the host). No guard in this Pack reads it;
 * it is declared only so the payload type does not lie about what is on the
 * envelope the kernel actually sees.
 */
export interface OrderReorderRequestPayload {
  readonly _workflowInstanceId?: string
}

/**
 * LE2-023 — the swap-for-coupon ASK (`order.coupon.swap.request`).
 *
 * ── WHY THIS ONE CARRIES AN AUTHORED FIELD AND THE REORDER ASK DOES NOT ──────
 *
 * `OrderReorderRequestPayload` above carries nothing because the value its act
 * needs is an ORDER ID, and an order id a language model reported is
 * indistinguishable from one it invented. This ask needs a COUPON CODE, which is
 * the opposite case in the one way that matters: the customer TYPED it. The model
 * is reporting a string the customer authored in the selecting utterance, not
 * originating an identifier that names somebody's money — and it arrives through
 * the workflow's closed slot surface, so `sanitizeWorkflowSlots` drops every key
 * the workflow does not declare before this payload is built.
 *
 * That is exactly the `WorkflowParamSource` `"slot"` member's warrant, and it is
 * why the swap route can be parameterised at all while the reorder route cannot.
 *
 * ── AND WHY THE GUARD STILL DOES NOT QUOTE THIS STRING BACK ──────────────────
 *
 * `confirmSwapForCoupon` names the coupon from `ctx.couponCode` — the code the
 * STORE matched — never from this field. The two differ whenever the customer
 * types `bemvindo15` and the promotion is `BEMVINDO15`, and quoting the store's
 * own spelling is both more accurate and structurally safer: an untrusted string
 * that reached a customer-facing sentence verbatim would be a prose-injection
 * surface on the one sentence the customer is asked to approve a cancellation
 * against. The projection round-trips it through the store first; see
 * `couponCode` on the ctx below.
 */
export interface OrderCouponSwapRequestPayload {
  /** The coupon code the customer authored, verbatim. See the doc above. */
  readonly code?: string
  /** Written by the WORKFLOW RUNTIME, never by a parse — the instance handle
   *  that survives the confirm park. No guard in this Pack reads it. */
  readonly _workflowInstanceId?: string
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
  | OrderReorderRequestPayload
  | OrderCouponSwapRequestPayload
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
     * BKL-280 — TRUE when the customer's OWN utterance on this turn carried an
     * explicit stay-home ("não vou poder sair de casa") or delivery-request
     * ("pago na entrega", "manda pra minha casa") marker.
     *
     * Stamped deterministically by the host at resolve time
     * (`hasStayHomeDeliveryMarker` → `resolveAndAssemble`,
     * apps/api/src/claustrum/resolve-and-assemble.ts) from a CLOSED list of
     * literal substrings. Data-independent in the SDD §H sense and, critically,
     * MODEL-UNFORGEABLE: it is derived from the customer's text, never from the
     * payload the planner emitted — which is what lets
     * `confirmDeliveryContradiction` (`./policies.ts`) catch a
     * `delivery_type: pickup` the model got wrong. Raw prose never reaches the
     * guard; only this boolean does.
     *
     * Like every other host-supplied flag on this ctx, LENIENT WHEN ABSENT: an
     * unwired host (or the confirm-RESUME path, which re-resolves with no
     * utterance text) leaves it undefined, the guard returns null, and the
     * checkout ladder behaves byte-identically to before this flag existed. The
     * guard only ever ADDS a question; absence can never turn a REFUSE into an
     * EXECUTE.
     */
    readonly stayHomeDeliveryMarker?: boolean
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
    /**
     * BKL-190 — present alongside `displayId` on the `"grounded"` path: TRUE
     * when the CURRENT staff message actually contains the resolved order's
     * display number (the ops resolver's `orderReferenceAppearsInMessage`
     * check). The confirm prompt splits its frame on this — a staff message
     * that DID name the order must not be told "não me disseram qual pedido"
     * (the extraction schema simply has no field for the reference to ride).
     */
    readonly orderNamedInMessage?: boolean
    /**
     * LE2-021 — THE PREVIOUS ORDER, projected by the host for the reorder-last
     * workflow's anchor (`order.reorder.request`). Four fields, all optional,
     * all fail-SAFE when absent.
     *
     * # Why they exist at all
     *
     * `confirmReorderLast` (`./policies.ts`) has to author a sentence naming
     * what the customer is about to re-buy — items and total — because a
     * confirmation that says only "confirma?" buys the customer nothing they
     * could check. Every other `ctx` field describing money or items on this
     * state describes the CURRENT cart (`items`, `totalInCentavos`), which for
     * a reorder is empty or, worse, someone's half-built unrelated basket. So
     * the previous order needs its own carrier.
     *
     * # Why the HOST stamps them and the payload does not carry them
     *
     * Same reason as {@link OrderReorderRequestPayload}: the model must not be
     * the source of an order id or of a price it will then be quoted back on.
     * The host reads them from the domain `OrderProjection` under an
     * OWNER-SCOPED query, so the values are first-party by construction and the
     * guard's sentence is grounded in the same sense every other grounded
     * action value in this Pack is.
     *
     * # Absent means NO HISTORY, and that is a decision, not a gap
     *
     * `confirmReorderLast` REFUSEs (honestly, `order.reorder.no_history`) when
     * `previousOrderId` is absent rather than confirming a repeat of nothing.
     * Lenient-when-absent here therefore means fail-SAFE, matching
     * `amendItemConfirmed` above: a host that has not wired the projection sees
     * the honest refusal, never a bypass.
     */
    readonly previousOrderId?: string
    /** The previous order's DISPLAY number — what a customer recognises. */
    readonly previousOrderDisplayId?: number
    /** The previous order's grand total, integer centavos (Hard Rule #2). */
    readonly previousOrderTotalInCentavos?: number
    /**
     * The previous order's lines, in the order the projection recorded them.
     * `title` is the product name as it was SOLD (the projection's own copy),
     * never a name re-derived at read time — a reorder confirm that renamed a
     * product would be quoting something the customer never bought.
     */
    readonly previousOrderItems?: ReadonlyArray<{
      readonly title: string
      readonly quantity: number
    }>
    /**
     * LE2-023 — the five fields `confirmSwapForCoupon` reads, on the same terms
     * as the four `previousOrder*` fields above: host-stamped from first-party
     * reads, all optional, and LENIENT-WHEN-ABSENT MEANING FAIL-SAFE.
     *
     * That last property is the one to hold on to, because for this guard it is
     * doing more work than it does for the reorder ask. Every one of these is a
     * precondition for a sentence that asks a customer to approve CANCELLING A
     * REAL ORDER, so the guard REFUSEs on any absence rather than confirming
     * around it — an unwired host, a failed promotion lookup and a genuinely
     * unusable coupon all converge on an honest sentence, and none of them can
     * produce a confirmation for a swap the system could not price.
     *
     * The first two are DERIVED host-side (in `previousOrderCtxFields`) from
     * sets this Pack itself exports — `CUSTOMER_POST_PONR_FULFILLMENT` and
     * `CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES` — rather than transcribed, so
     * the projection that decides whether to OFFER the swap and the guards that
     * will later decide whether to ALLOW the cancel (`requireCancellable`,
     * `gatePaidCancel`) cannot drift apart.
     */
    readonly previousOrderIsCancelable?: boolean
    /**
     * Whether the previous order's money is already captured — what makes the
     * confirm's REFUND CLAUSE true. The sentence states the refund consequence
     * exactly when this is `true`, because "cancelar implica reembolso" is a
     * promise about money moving back, and on an unpaid order there is no money
     * to move. It is also the precise condition under which `gatePaidCancel`
     * asks its own confirm, which is the question the workflow's declared
     * coverage covers.
     */
    readonly previousOrderPaymentIsSettled?: boolean
    /** Whether the named coupon is usable RIGHT NOW, from the same
     *  `evaluatePromotionRecord` predicate the display route and the
     *  COUPON_VALID claim read. ABSENT when the lookup could not be made at all
     *  — which is NOT `false`, and the guard treats the two the same way only
     *  because both refuse (see `coupon-price-projection.ts` on Inv 7). */
    readonly couponIsValid?: boolean
    /** What the rebuilt basket costs with the coupon applied, integer centavos
     *  (Hard Rule #2). ABSENT for every promotion shape this system cannot price
     *  soundly, so the guard refuses to quote rather than quoting a number
     *  checkout would not honour. */
    readonly couponNewTotalInCentavos?: number
    /**
     * The coupon code AS THE STORE SPELLS IT — read off the matched promotion
     * record, never off the envelope payload. See
     * `OrderCouponSwapRequestPayload` above for why the difference is
     * load-bearing rather than cosmetic.
     */
    readonly couponCode?: string
    /**
     * BKL-103 / AUT-017 — the ESCALATE→OWNER-approve→executable-resume marker for
     * the RESUMABLE `order.cancel` escalation. Structural mirror of
     * `PaymentState.ctx.escalationApproval` (`@ibatexas/pack-payments`).
     *
     * Present ONLY on the adopter-side escalation-approval RESUME path (never on
     * an ordinary turn): `createEscalationApprovalEngine`
     * (apps/api/src/escalation/escalation-approval.ts) re-projects the FRESH
     * order state and stamps this marker, so `gatePaidCancel`'s escalate band
     * converts its OWN ESCALATE into a REQUEST_CONFIRMATION, which the paired
     * `confirmationReceipt` (same `intentHash`) then flips to EXECUTE via the
     * kernel's 2a override. The marker rides STATE, never the payload — so
     * `intentHash` is unchanged and it is unforgeable from the wire.
     *
     * Absent ⟹ the escalate band is BYTE-IDENTICAL to its pre-BKL-103 behaviour
     * (a >=R$1.000 paid cancel ESCALATEs).
     */
    readonly escalationApproval?: {
      /** The parked envelope's `intentHash` — MUST equal `envelope.intentHash`. */
      readonly intentHash: string
      /** The approving staff id (raw staffId — NOT the proposer, checked below). */
      readonly approverId: string
      /** The approving staff role — the overlay fires ONLY for `"OWNER"`. */
      readonly approverRole: string
      /** ISO-8601 wall-clock of the OWNER approval. */
      readonly at: string
    }
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
