/**
 * kind-resolution-profiles — THE DECLARED TABLE of what RESOLVE does per intent
 * kind (R3-S3, extended with the id-threading axis by R3-S4).
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 *
 * "What does the resolve stage do for kind X?" had no answer you could read. It
 * was smeared across EIGHT parallel kind-sets in `resolve-and-assemble.ts`
 * (PREVIOUS_ORDER_CTX / COUPON_SWAP_CTX / ORDER_BY_ID / ORDER_AUTORESOLVE /
 * ORDER_NAMED_REFERENCE / RESERVATION_AUTORESOLVE / RESERVATION_SLOT_RESOLVE /
 * REFUND_OWNERSHIP), a ninth hand-mirrored set in `compose-policy-packs.ts`
 * (AUTORESOLVE_CONFIRM_KINDS), and a scatter of `kind === "…"` gates inside the
 * per-kind normalizers and the id-threading stage. Answering the question meant
 * grepping a 2.8k-line file for the kind string and hoping you found every site.
 *
 * As of R3-S4 there is no such gate left: `resolve-and-assemble.ts` contains ZERO
 * intent-kind comparisons outside the accessors below.
 *
 * The cost was not readability, it was DRIFT. Membership in one set implies
 * membership in another — auto-resolving a target you must then confirm; loading
 * by id so the ownership graph can bind — and those implications lived only in
 * comments. R3-S1 found one such mirror had ALREADY rotted (a hand copy omitting
 * `order.review.submit` + `reservation.modify`) and made the equality a test.
 * This slice removes the second declaration entirely: there is now ONE row per
 * kind, and every set is a DERIVED VIEW of it.
 *
 * ── WHAT A ROW DECLARES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
 *
 * A row says WHAT the resolve stage does for a kind. It never says WHEN.
 *
 * Stage ordering is load-bearing and stays in the interpreter
 * (`resolveAndAssemble`): renames run before auto-resolve because a rename feeds
 * it; the refund binding runs after auto-resolve; slot resolution runs after that
 * because a modify's party-size source is the reservation auto-resolve just
 * resolved; `stampCouponSwapCtx` runs after `stampPreviousOrderCtx` because it
 * prices a coupon against the total that projection resolved. Encoding order in
 * a table of independent rows would have thrown that away — a row cannot express
 * "after the other one" without becoming a program.
 *
 * So: the table is a set of INDEPENDENT per-kind facts; the interpreter is the
 * one place the sequence lives.
 *
 * ── THE THREE INDEPENDENT TARGET AXES (derived from the sets, not assumed) ───
 *
 * The eight sets look like one taxonomy and are not. `reservation.modify` proves
 * it: it is in RESERVATION_AUTORESOLVE_KINDS (its reservationId is auto-resolved)
 * AND it grounds an NL date/time to a slot AND it takes neither the same code
 * path nor the same keys as `reservation.create`, which auto-resolves nothing.
 * `payment.refund.issue` proves it from the other side: it binds an owning
 * orderId but that is explicitly NOT an auto-resolve (the refund target stays the
 * caller's explicit paymentId), so it must not force a confirm.
 *
 * Three axes, therefore, not one enum:
 *
 *   targetResolution  — how the MUTATION TARGET is reached when left implicit
 *   slotResolution    — whether an NL date/time is grounded to a real slot id,
 *                       and under WHICH key group (create keys vs modify keys)
 *   ownershipBinding  — whether a non-target id is derived so the kernel
 *                       ownership graph has something to bind
 *
 * Note what is NOT a strategy value: "explicit-id". Every order strategy already
 * honours an explicit id FIRST (`resolveOrderId`'s own first branch), so
 * "explicit id wins" is a property of all of them rather than an alternative to
 * them. The vocabulary below is what the code actually branches on.
 *
 * ── THE FAIL-CLOSED DEFAULT ──────────────────────────────────────────────────
 *
 * A kind with no row gets {@link UNPROFILED_KIND}: no target resolution, no
 * confirm, no slot grounding, no ownership binding, no normalizers, no
 * projections, no kind-specific threading, and NO SIGNAL IT MAY STAMP. That is
 * the safe direction on every axis — an unknown kind cannot silently acquire an
 * auto-resolve, and it cannot stamp an honesty-floor signal it was never declared
 * to carry.
 *
 * TWO axes cannot mean "nothing" when absent, because both were PREFIX facts
 * about a whole domain rather than per-kind facts, over a kind space that is
 * genuinely open (ops kinds, whatsapp kinds and unknown kinds all reach this
 * resolver):
 *
 *   `ctxLoader` — every kind gets some loader; the question is only which. Its
 *     default is `"domain-default"`: consult {@link DOMAIN_DEFAULT_CTX_LOADERS},
 *     the prefix ladder `loadCtxForKind` always used. A row's explicit value is an
 *     OVERRIDE of its domain's default, which is exactly what ORDER_BY_ID_KINDS
 *     encoded (order kinds that load by id instead of as cart ops).
 *   `threadingSteps` (R3-S4) — every `order.` kind threads its resolved cartId
 *     and every `reservation.` kind its customerId, whether or not it has a row.
 *     Its default is the {@link DOMAIN_DEFAULT_THREADING_STEPS} baseline, and a
 *     row's steps are ADDITIVE to it rather than an override, because threading is
 *     a set and a loader is not.
 *
 * The asymmetry is deliberate and is the honest scope line: a table that claimed
 * to be TOTAL over kinds would either be a lie or a regression. Read both axes
 * through their accessors ({@link ctxLoaderFor}, {@link threadingStepsFor}) — the
 * raw row field is only half the answer.
 *
 * ── WHY THIS MODULE HAS NO RUNTIME DEPENDENCIES ──────────────────────────────
 *
 * `compose-policy-packs.ts` derives AUTORESOLVE_CONFIRM_KINDS from this table, so
 * this module must not drag the 2.8k-line resolver (and its domain services /
 * Redis / Medusa imports) into the policy-composition graph — the same discipline
 * `resolution-signals.ts` was built with in R3-S2, and for the same reason. It
 * imports that contract and nothing else.
 */

import {
  ALLERGEN_MENTION_DETECTED,
  AMEND_ITEM_UNRESOLVED,
  AUTO_RESOLVED_MONEY_REF,
  REVIEW_PRODUCT_UNRESOLVED,
  SESSION_TOKENS_CONSUMED,
  STAY_HOME_DELIVERY_MARKER,
  stampResolutionSignal,
  type ResolutionSignalName,
  type ResolutionSignalSink,
  type ResolutionSignals,
} from "./resolution-signals.js";

// ── The declared vocabularies ────────────────────────────────────────────────

/**
 * How a kind reaches the entity it MUTATES when the customer left it implicit
 * ("cancela meu pedido"). Each value names one branch of `applyAutoResolve`, and
 * the four non-`none` values PARTITION the kinds that branch handles — a kind has
 * exactly one, which is what makes the old `if (ORDER_AUTORESOLVE) { if (review)
 * … if (NAMED_REFERENCE) … }` nesting expressible as a flat read.
 */
export type TargetResolution =
  /** No implicit-target resolution at all. The overwhelming majority of kinds. */
  | "none"
  /**
   * `resolveOrderId` — an explicit `orderId` wins; otherwise BLIND-resolve the
   * customer's most-recent order. A guess, so it always confirms.
   */
  | "order-most-recent"
  /**
   * BKL-216 `resolveAmendOrderReference` — honour an order the customer NAMED in
   * the message ("tira a coca do pedido 933869") before falling back to the blind
   * most-recent resolution; ≥2 owned matches stamp the ambiguity markers instead.
   * A NAMED order is not a guess, so only the fallback branch confirms.
   */
  | "order-named-reference"
  /**
   * FE-D28 `resolveCustomerOrderReference` — an explicit `orderReference` DISPLAY
   * number, IDOR-checked, else the most-recent fallback. Confirms on EITHER
   * branch (a public review posts against the resolved order).
   */
  | "order-display-reference"
  /**
   * FE-T14 `resolveReservationId` — the customer's ONE active reservation when
   * unambiguous, never a guess among several (≥2 stamp the BKL-223 markers).
   */
  | "reservation-active";

/**
 * Whether the kind grounds an NL date/time to a REAL `timeSlotId`, and under
 * which key group. The key group IS the discriminator `resolveReservationSlot`
 * branches on: a create reads `timeSlotId`/`date`/`time`, a modify reads
 * `newTimeSlotId`/`newDate`/`newTime` and sources its party size from the
 * already-resolved reservation rather than the payload.
 */
export type SlotResolution = "none" | "create-keys" | "modify-keys";

/**
 * 034-F1 — whether a non-target id is derived so the kernel ownership graph has a
 * resource to bind. NOT a target resolution and NOT a confirm trigger: the refund
 * target stays the caller's explicit `paymentId`; only the owning `orderId` is
 * derived, so `loadPaymentCtx` can confirm ownership instead of running inert.
 */
export type OwnershipBinding = "none" | "refund-payment-order";

/**
 * Which `loadCtxForKind` loader builds the kind's adjudication ctx.
 * `"domain-default"` means "consult {@link DOMAIN_DEFAULT_CTX_LOADERS}" and is
 * the value of the unprofiled default only — a real row always names a loader.
 */
export type CtxLoaderSelection =
  | "payment"
  | "order-by-id"
  | "reservation"
  | "customer"
  | "cart"
  | "base"
  | "domain-default";

/**
 * The kind-gated PURE payload transforms the normalization stage may apply.
 * SELECTION only — each implementation stays the small pure function it is in
 * `resolve-and-assemble.ts`; what moves here is the `if (kind !== "…") return
 * payload` gate each one used to carry, so the answer to "which kinds normalize?"
 * is readable in one place instead of four function bodies.
 */
export type PayloadNormalizer =
  /** FE-T12 — `payment_method` → `paymentMethod` + closed-synonym value map. */
  | "checkout-payment-method"
  /** FE-T12 — `delivery_type` → `deliveryType` + closed-synonym value map. */
  | "checkout-delivery-type"
  /** FE-T14 — `dietary_restrictions`/`favorite_categories` → the internal keys. */
  | "preferences-wire-fields"
  /** BKL-227 — recover `newPartySize` from the customer's own words. */
  | "modify-party-size";

/**
 * The additive ctx projections stamped after the loader has run. ORDER-DEPENDENT
 * on each other (`coupon-swap` prices against the total `previous-order`
 * resolves) — the table declares WHICH apply, the interpreter keeps the order.
 */
export type CtxProjection =
  /** LE2-021/023/024 — the four `previousOrder*` fields for a projected last order. */
  | "previous-order"
  /** LE2-023 — the coupon fields `confirmSwapForCoupon` reads. */
  | "coupon-swap";

/**
 * R3-S4 — the ID-THREADING steps `threadResolvedIdsIntoPayload` may apply to the
 * OUTGOING payload, after the ctx is built.
 *
 * This is the last stage that was still a wall of `kind === "…"` gates. The names
 * below are taken from what each gate's body DOES, which is worth stating because
 * two of them are not what the stage's name suggests: the `order.` prefix gate
 * threads a **cartId** (never an orderId — that was already resolved upstream by
 * `applyAutoResolve`), and the `reservation.` prefix gate threads a **customerId**.
 *
 * SELECTION only, exactly as `payloadNormalizers` established in R3-S3: each body
 * stays the function it was in `resolve-and-assemble.ts`, and what moved here is
 * the kind gate it wore. Sequence — and the two places one step NESTS inside
 * another's runtime guard — stay in the interpreter.
 */
export type ThreadingStep =
  /**
   * F3/L1 (D-014) — copy the session-resolved `ctx.cartId` onto the payload so a
   * cart mutation does not EXECUTE and then ZodError on the missing id. Never
   * overrides an explicit value, and self-scoping: `ctx.cartId` is a string only
   * for kinds that routed through `loadCartCtx`.
   */
  | "thread-cart-id"
  /**
   * F3/L1 (D-014) — reservation executors require `customerId` (identity, never
   * LLM-supplied). Never overrides an explicit value.
   */
  | "thread-reservation-customer-id"
  /**
   * BKL-103 — stamp the authenticated `actorId` PROPOSER field `gatePaidCancel`'s
   * overlay compares against `approval.approverId`. UNCONDITIONAL overwrite: a
   * fill-only-if-absent would be defeated by a smuggled value.
   */
  | "stamp-cancel-actor"
  /**
   * BKL-061/067/199 + FE-T09 — resolve a loose NL product name to `variantId`,
   * refill `allergens` from the RESOLVED PRODUCT (Hard Rule #1: always an
   * explicit array, never model-supplied — the field is stripped unconditionally
   * first), and recover the customer's stated `quantity`.
   *
   * The three travel as ONE step because no kind takes them apart: both selecting
   * kinds want all three, and splitting would create a co-selection invariant this
   * table has no way to enforce (a row could declare the hydration without the
   * allergen refill — precisely the Hard-Rule-#1 hole the step exists to close).
   */
  | "hydrate-product-with-allergens"
  /** FE-T09 (D-a) — resolve the NL `item` reference against a PLACED order's own
   *  line items (`resolveOrderLineItem`); never a catalog-wide guess. */
  | "resolve-order-line-item"
  /** FE-T14 — the same NL→`itemId` shape resolved against the ACTIVE CART
   *  (`resolveCartLineItem`), whose wire schema needs a real Medusa line id. */
  | "resolve-cart-line-item"
  /**
   * Review B3 — positive-integer coercion of the quantity a `*.update_qty` /
   * `*.item.update` carries. NESTED inside whichever line-item resolution the kind
   * also declares (see the interpreter): it has never run on a turn that arrived
   * with an explicit `itemId`, and hoisting it would change that.
   */
  | "coerce-line-item-quantity"
  /** FE-D28 — resolve the reviewed `productId` from the reviewed order's OWN line
   *  items (a review is purchase-bound). Never guesses; the interpreter stamps the
   *  `reviewProductUnresolved` honesty floor when it does not resolve. */
  | "resolve-review-product"
  /**
   * FE-T14 — `allergenExclusions` is REQUIRED on the wire but is never on the
   * extraction schema (Hard Rule #1). Stripped unconditionally and refilled from
   * the customer's CURRENT saved preferences, so an ordinary "sou vegetariano"
   * cannot silently wipe a declared allergy.
   */
  | "refill-allergen-exclusions";

// ── The row ──────────────────────────────────────────────────────────────────

/**
 * Everything the resolve stage does for one intent kind, in the axes this slice
 * declares. EVERY FIELD IS REQUIRED: a row that omitted one would silently take
 * the unprofiled default, which is exactly the "it was never declared anywhere"
 * failure the table exists to end. Writing `"none"` / `false` / `[]` is a
 * decision on the record.
 */
export interface KindResolutionProfile {
  /** How the mutation target is reached when the customer left it implicit. */
  readonly targetResolution: TargetResolution;
  /**
   * Whether an AUTO-RESOLVED target must be confirmed before it executes.
   * Derives `AUTORESOLVE_CONFIRM_KINDS`. Declared independently of
   * `targetResolution` ON PURPOSE: making it a function of the strategy would
   * make the R3-S1 lockstep contract tautological and delete the coverage. As two
   * fields, "every auto-resolving kind confirms" stays a REAL claim about this
   * table that a row can violate — see `autoresolve-confirm-lockstep.test.ts`.
   */
  readonly confirmOnAutoResolve: boolean;
  /** Which loader builds the adjudication ctx (an override of the domain default). */
  readonly ctxLoader: CtxLoaderSelection;
  /** Whether an NL date/time is grounded to a real slot id, under which key group. */
  readonly slotResolution: SlotResolution;
  /** Whether an owning id is derived for the kernel ownership graph. */
  readonly ownershipBinding: OwnershipBinding;
  /** Which pure payload normalizers the normalization stage applies. */
  readonly payloadNormalizers: readonly PayloadNormalizer[];
  /** Which additive ctx projections are stamped after the loader. */
  readonly ctxProjections: readonly CtxProjection[];
  /**
   * R3-S4 — which id-threading steps run against the OUTGOING payload, ON TOP OF
   * the kind's domain baseline ({@link DOMAIN_DEFAULT_THREADING_STEPS}). Read
   * through {@link threadingStepsFor}, never directly: a row declares only what is
   * SPECIFIC to the kind, so reading this field alone would miss the prefix
   * threads every `order.` / `reservation.` kind gets.
   */
  readonly threadingSteps: readonly ThreadingStep[];
  /**
   * The R3-S2 resolution signals this kind MAY stamp — the honesty-floor channel
   * the kernel guards read. ENFORCED, not documentation: `stampProfiledSignal`
   * refuses an undeclared (kind, signal) pair, so the kind gate on a stamp site
   * and the declaration here cannot disagree. Universal signals
   * ({@link UNIVERSAL_RESOLUTION_SIGNALS}) are stamped for every envelope and are
   * deliberately not repeated on every row.
   */
  readonly signals: readonly ResolutionSignalName[];
}

/**
 * The profile of a kind with no row — every axis at its safe value.
 *
 * Exported so the fail-closed default is a thing tests can assert against rather
 * than a behaviour they have to infer. See the module docblock for why
 * `ctxLoader` is `"domain-default"` rather than `"base"`: it is the one axis
 * where "no declaration" cannot mean "do nothing".
 */
export const UNPROFILED_KIND: KindResolutionProfile = {
  targetResolution: "none",
  confirmOnAutoResolve: false,
  ctxLoader: "domain-default",
  slotResolution: "none",
  ownershipBinding: "none",
  payloadNormalizers: [],
  ctxProjections: [],
  signals: [],
  // NOT the whole answer for an unprofiled kind, and deliberately so: the domain
  // baseline still applies on top (an unlisted `order.` kind still gets its cartId
  // threaded, which is what kept every un-rowed cart op working before this
  // slice). `threadingStepsFor` is where the two combine.
  threadingSteps: [],
};

// ── The table ────────────────────────────────────────────────────────────────

/**
 * A row exists for a kind IFF the resolve stage does something kind-specific in
 * one of the declared axes. `kind-resolution-profiles.test.ts` pins this rule —
 * every row must be non-default somewhere.
 *
 * R3-S4 applied that rule to a new axis rather than bending it. The previous
 * revision of this docblock named `order.item.add` and `order.item.update` as
 * kinds deliberately left un-rowed, "because that machinery is not yet profiled"
 * — id-threading was the one stage still gated by `kind === "…"`. It is profiled
 * now, so those three kinds are non-default in `threadingSteps` and have earned
 * rows on exactly the stated rule. Nothing about the rule changed; the set of
 * axes did.
 *
 * Grouped by what the kinds have in common, and every group's membership is
 * pinned against a hand-written control list in the test's census.
 */
export const KIND_RESOLUTION_PROFILES: Readonly<Record<string, KindResolutionProfile>> = {
  // ── Order kinds that mutate a PLACED order ─────────────────────────────────
  // All load by id (034-F1: the ownership graph needs `resourceOwnerConfirmed`,
  // and the cart loader never sets it), all auto-resolve an implicit "meu
  // pedido", all therefore confirm.
  "order.cancel": {
    targetResolution: "order-most-recent",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    // BKL-103 — the conversational plane's PROPOSER stamp. The only kind that
    // needs it: it is the only RESUMABLE escalation kind whose overlay compares
    // an approver against a proposer.
    threadingSteps: ["stamp-cancel-actor"],
  },
  // BKL-216 — the amend kinds honour a NAMED order before the blind fallback.
  "order.amend.request": {
    targetResolution: "order-named-reference",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: [],
  },
  "order.amend.add_item": {
    targetResolution: "order-named-reference",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    // FE-D18 — the honesty floor that REFUSEs an unresolvable item BEFORE the
    // confirm guard can park a doomed envelope behind a found-implying prompt.
    signals: [AUTO_RESOLVED_MONEY_REF, AMEND_ITEM_UNRESOLVED],
    // Shares the hydration step with its cart sibling `order.item.add`; what
    // separates them is the signal above, which is why the stamp is gated by the
    // DECLARATION rather than by a second kind test inside the step.
    threadingSteps: ["hydrate-product-with-allergens"],
  },
  "order.amend.update_qty": {
    targetResolution: "order-named-reference",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: ["resolve-order-line-item", "coerce-line-item-quantity"],
  },
  "order.amend.remove_item": {
    targetResolution: "order-named-reference",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    // A removal carries no quantity — the one field that separates it from its
    // update_qty sibling, which is why the coercion is its own step.
    threadingSteps: ["resolve-order-line-item"],
  },
  "order.note.add": {
    targetResolution: "order-most-recent",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: [],
  },
  "order.address.change": {
    targetResolution: "order-most-recent",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: [],
  },
  "order.type.switch": {
    targetResolution: "order-most-recent",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: [],
  },
  // FE-D28 — the one kind reaching its order by DISPLAY number.
  "order.review.submit": {
    targetResolution: "order-display-reference",
    confirmOnAutoResolve: true,
    ctxLoader: "order-by-id",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    // The review-product honesty floor, same posture as the amend flag above.
    signals: [AUTO_RESOLVED_MONEY_REF, REVIEW_PRODUCT_UNRESOLVED],
    threadingSteps: ["resolve-review-product"],
  },

  // ── Payment kinds ─────────────────────────────────────────────────────────
  // A PIX regenerate targets the customer's most-recent ORDER (its ctx comes from
  // the payment loader, which is why loader and strategy disagree here — the two
  // axes are independent).
  "payment.pix.regenerate": {
    targetResolution: "order-most-recent",
    confirmOnAutoResolve: true,
    ctxLoader: "payment",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    // No `payment.` domain baseline: the two prefix threads serve order and
    // reservation executors only.
    threadingSteps: [],
  },
  // 034-F1 — ownership BINDING only. No target resolution, so NO forced confirm:
  // the refund target stays the caller's explicit paymentId.
  "payment.refund.issue": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "payment",
    slotResolution: "none",
    ownershipBinding: "refund-payment-order",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [],
    threadingSteps: [],
  },
  "payment.refund.confirm": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "payment",
    slotResolution: "none",
    ownershipBinding: "refund-payment-order",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [],
    threadingSteps: [],
  },

  // ── Reservation kinds ─────────────────────────────────────────────────────
  // Every reservation kind threads its customerId, but NOT from a row: that is
  // the `reservation.` domain baseline, so the open kind space keeps it.
  "reservation.cancel": {
    targetResolution: "reservation-active",
    confirmOnAutoResolve: true,
    ctxLoader: "reservation",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: [],
  },
  // The kind that proves the axes are independent: it auto-resolves its
  // reservation AND grounds a slot AND recovers a party size from the utterance.
  "reservation.modify": {
    targetResolution: "reservation-active",
    confirmOnAutoResolve: true,
    ctxLoader: "reservation",
    slotResolution: "modify-keys",
    ownershipBinding: "none",
    payloadNormalizers: ["modify-party-size"],
    ctxProjections: [],
    signals: [AUTO_RESOLVED_MONEY_REF],
    threadingSteps: [],
  },
  // FE-D27 — create/waitlist ground a slot but auto-resolve NO target (there is
  // no existing booking to guess at), so they never confirm.
  "reservation.create": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "reservation",
    slotResolution: "create-keys",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [],
    threadingSteps: [],
  },
  "reservation.waitlist.join": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "reservation",
    slotResolution: "create-keys",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [],
    threadingSteps: [],
  },

  // ── Cart-plane order kinds with a declared projection or normalizer ────────
  // The three WORKFLOW ANCHORS that read the customer's previous order. They are
  // cart-plane kinds (`*.request` anchors, not placed-order mutations), so their
  // loader is the cart loader — the projection is ADDITIVE on top of it.
  "order.reorder.request": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: ["previous-order"],
    signals: [],
    threadingSteps: [],
  },
  "order.coupon.swap.request": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    // ORDER MATTERS at the interpreter: the coupon is priced against the total
    // the previous-order projection resolves.
    ctxProjections: ["previous-order", "coupon-swap"],
    signals: [],
    threadingSteps: [],
  },
  "order.cancel.request": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: ["previous-order"],
    signals: [],
    threadingSteps: [],
  },
  // Deliberately NOT auto-resolved: a checkout's cartId comes from the session's
  // active-cart key — THE customer's one cart, not a guess among several.
  "order.checkout.create": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: ["checkout-payment-method", "checkout-delivery-type"],
    ctxProjections: [],
    // BKL-280 — the one signal read in a PUBLISHED PACK.
    signals: [STAY_HOME_DELIVERY_MARKER],
    // The cartId it checks out arrives via the `order.` domain baseline, not a
    // row — same thread every cart op gets.
    threadingSteps: [],
  },

  // ── Cart line-item kinds (R3-S4: rows for the FIRST time) ─────────────────
  // Before this slice these three had no row, because the table did not yet have
  // an axis for the only thing that is special about them: their id-threading.
  // Everything else about them IS the default — no auto-resolve, no confirm, the
  // domain cart loader, no normalizer, no projection, no signal.
  "order.item.add": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    // NOT `amendItemUnresolved`: an unresolvable item on the CART path already
    // REFUSEs honestly (no confirm parks it first), so the flag would be an
    // honesty floor with nothing to protect. The asymmetry with
    // `order.amend.add_item` is the whole reason that stamp reads the table.
    signals: [],
    threadingSteps: ["hydrate-product-with-allergens"],
  },
  "order.item.update": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [],
    threadingSteps: ["resolve-cart-line-item", "coerce-line-item-quantity"],
  },
  "order.item.remove": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "cart",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: [],
    ctxProjections: [],
    signals: [],
    threadingSteps: ["resolve-cart-line-item"],
  },

  // ── Customer kinds ────────────────────────────────────────────────────────
  "customer.preferences.update": {
    targetResolution: "none",
    confirmOnAutoResolve: false,
    ctxLoader: "customer",
    slotResolution: "none",
    ownershipBinding: "none",
    payloadNormalizers: ["preferences-wire-fields"],
    ctxProjections: [],
    // FE-T14 — the allergen honesty floor.
    signals: [ALLERGEN_MENTION_DETECTED],
    threadingSteps: ["refill-allergen-exclusions"],
  },
};

/**
 * The signals stamped for EVERY envelope regardless of kind, so they are not
 * repeated on (and must not be gated by) any row.
 *
 * Exactly one today: the F4 session token counter, read back from Redis on every
 * turn precisely so the budget guard sees a real total rather than a value that
 * happens to exist for some kinds. Gating it per kind would silently disable the
 * cost cap for every unlisted kind — the opposite of what a fail-closed default
 * should do, and the reason this carve-out is explicit rather than a special case
 * hidden in the stamp helper.
 */
export const UNIVERSAL_RESOLUTION_SIGNALS: readonly ResolutionSignalName[] = [
  SESSION_TOKENS_CONSUMED,
];

/**
 * The prefix ladder `loadCtxForKind` has always used, for kinds with no row.
 *
 * ORDER MATTERS — first match wins — and this is the same order the if-chain had,
 * minus the ORDER_BY_ID_KINDS test, which is now the per-kind override. Hoisting
 * that override above the whole ladder is behaviour-preserving because no
 * ORDER_BY_ID kind is a `payment.` kind (the one prefix that used to precede it),
 * and every row's declared loader is pinned against the pre-migration ladder by
 * the test's loader census.
 */
export const DOMAIN_DEFAULT_CTX_LOADERS: ReadonlyArray<
  readonly [prefix: string, loader: CtxLoaderSelection]
> = [
  ["payment.", "payment"],
  ["reservation.", "reservation"],
  ["customer.", "customer"],
  // Remaining order.* are cart/draft ops (ensure / item.* / checkout / coupon).
  ["order.", "cart"],
];

/**
 * R3-S4 — the id-threading steps a kind gets from its DOMAIN, before any row.
 *
 * The second total axis, and for the same reason as {@link
 * DOMAIN_DEFAULT_CTX_LOADERS}: these two steps were `kind.startsWith("order.")`
 * and `kind.startsWith("reservation.")` tests, i.e. facts about a whole domain
 * over an OPEN kind space. Rewriting them as per-kind rows would have required
 * enumerating every `order.` kind that can reach this resolver and would have
 * silently dropped the thread for the next one added — a regression, not a
 * refactor. So the prefix stays a prefix, and it stays declared HERE rather than
 * inline in the interpreter.
 *
 * ADDITIVE, unlike the loader ladder (which is an OVERRIDE, because a kind gets
 * exactly one loader). Threading is a SET axis: a row's steps COMPOSE with its
 * domain baseline instead of replacing it, so `order.cancel` declaring
 * `stamp-cancel-actor` does not have to re-declare the cartId thread that every
 * other order kind gets. The cost of that choice is stated plainly: a row CANNOT
 * opt out of its domain baseline. Nothing needs to today — both threads are
 * no-ops when their input is absent (`ctx.cartId` is a string only for kinds that
 * routed through `loadCartCtx`), so they are already self-scoping at runtime. A
 * kind that genuinely had to suppress one would need a declared suppression, not
 * a silent omission, and this comment is the marker for that day.
 *
 * Every matching prefix contributes (a union, not first-match-wins). The two
 * prefixes are disjoint, so the distinction is not observable today; union is
 * declared because it is the composition-safe reading of a set.
 */
export const DOMAIN_DEFAULT_THREADING_STEPS: ReadonlyArray<
  readonly [prefix: string, steps: readonly ThreadingStep[]]
> = [
  ["order.", ["thread-cart-id"]],
  ["reservation.", ["thread-reservation-customer-id"]],
];

// ── Reading the table ────────────────────────────────────────────────────────

/**
 * The profile for a kind — its row, or the fail-closed {@link UNPROFILED_KIND}.
 *
 * TOTAL by design: the interpreter never has to ask whether a row exists, so
 * there is no `?.` on a profile read and no branch where a missing row means
 * something other than "none of it".
 */
export function resolutionProfileFor(kind: string): KindResolutionProfile {
  return KIND_RESOLUTION_PROFILES[kind] ?? UNPROFILED_KIND;
}

/**
 * Which loader builds this kind's ctx: the row's override, else the domain
 * default, else the identity base (unknown / whatsapp / ops kinds — guards
 * needing entity state see null and REFUSE cleanly, never panic).
 */
export function ctxLoaderFor(kind: string): Exclude<CtxLoaderSelection, "domain-default"> {
  const declared = resolutionProfileFor(kind).ctxLoader;
  if (declared !== "domain-default") return declared;
  for (const [prefix, loader] of DOMAIN_DEFAULT_CTX_LOADERS) {
    if (kind.startsWith(prefix)) {
      return loader as Exclude<CtxLoaderSelection, "domain-default">;
    }
  }
  return "base";
}

/**
 * R3-S4 — every id-threading step this kind runs: its domain baseline
 * ({@link DOMAIN_DEFAULT_THREADING_STEPS}) UNION its row's own steps.
 *
 * Returns a SET, deliberately. The interpreter asks `has(step)` at fixed points in
 * a fixed sequence, so the order a row happens to list its steps in cannot change
 * what runs when — the same "the table declares WHAT, the interpreter decides
 * WHEN" split R3-S3's `payloadNormalizers` had to spell out in prose. A set makes
 * it structural.
 */
export function threadingStepsFor(kind: string): ReadonlySet<ThreadingStep> {
  const steps = new Set<ThreadingStep>();
  for (const [prefix, domainSteps] of DOMAIN_DEFAULT_THREADING_STEPS) {
    if (kind.startsWith(prefix)) for (const step of domainSteps) steps.add(step);
  }
  for (const step of resolutionProfileFor(kind).threadingSteps) steps.add(step);
  return steps;
}

/**
 * 034-F1 — do the loaders that set `resourceOwnerConfirmed` serve this kind?
 *
 * Exactly `loadOrderCtx` and `loadPaymentCtx`. This replaces the open-coded
 * `kind.startsWith("payment.") || ORDER_BY_ID_KINDS.has(kind)` in two places
 * (`ownershipIndeterminate`, and the coverage test's mirror of the dispatch) with
 * a question asked of the loader itself, so a kind rerouted to a different loader
 * can no longer keep the old ownership answer.
 */
export function ctxLoaderConfirmsOwnership(kind: string): boolean {
  const loader = ctxLoaderFor(kind);
  return loader === "payment" || loader === "order-by-id";
}

/**
 * May this kind stamp this signal? Universal signals always; otherwise only what
 * the row declared. An unprofiled kind may stamp NOTHING kind-specific.
 */
export function kindMayStamp(kind: string, signal: ResolutionSignalName): boolean {
  return (
    UNIVERSAL_RESOLUTION_SIGNALS.includes(signal) ||
    resolutionProfileFor(kind).signals.includes(signal)
  );
}

/**
 * THE PROFILED WRITER — stamp a resolution signal the kind is DECLARED to carry.
 *
 * Wraps R3-S2's `stampResolutionSignal` (which pins the KEY SPELLING and the
 * VALUE TYPE) with the question that contract could not ask: is this kind allowed
 * to carry this signal at all? Together they close both halves — a signal now has
 * one spelling, one type, and one declared set of kinds.
 *
 * THROWS on an undeclared pair rather than skipping. Skipping would be the
 * fail-OPEN direction: every honesty-floor guard PASSES when its signal is
 * absent, so a silently-dropped stamp is an un-guarded EXECUTE — precisely the
 * failure R3-S2 was built to prevent, reintroduced one layer up. Unreachable in
 * production by construction (every stamp site's kind gate IS this declaration
 * after R3-S3), and the test drives both directions.
 */
export function stampProfiledSignal<K extends ResolutionSignalName>(
  ctx: ResolutionSignalSink,
  kind: string,
  signal: K,
  value: NonNullable<ResolutionSignals[K]>,
): void {
  if (!kindMayStamp(kind, signal)) {
    throw new Error(
      `kind-resolution-profiles: "${kind}" is not declared to stamp the resolution ` +
        `signal "${signal}". Add it to the kind's \`signals\` in KIND_RESOLUTION_PROFILES, ` +
        `or remove the stamp.`,
    );
  }
  stampResolutionSignal(ctx, signal, value);
}

// ── The derived views ────────────────────────────────────────────────────────
//
// The kind-sets that used to be hand-maintained. They are now VIEWS: nothing in
// production reads them (the interpreter reads profile fields directly), and they
// exist so the coverage contracts — R3-S1's autoresolve⇄confirm lockstep, 034-F1's
// ownership gating, and this slice's own census — keep pinning the same relations
// they always did, against a table that can no longer disagree with itself.
//
// Exported for those tests, following the R3-S1 precedent that made
// ORDER_AUTORESOLVE_KINDS / RESERVATION_AUTORESOLVE_KINDS importable for exactly
// this purpose. `ReadonlySet` because a view must not be mutable.

/** Every kind with a row whose profile satisfies the predicate. */
function derivedKindSet(
  predicate: (profile: KindResolutionProfile) => boolean,
): ReadonlySet<string> {
  return new Set(
    Object.entries(KIND_RESOLUTION_PROFILES)
      .filter(([, profile]) => predicate(profile))
      .map(([kind]) => kind),
  );
}

/** The three `targetResolution` values that reach an ORDER. */
const ORDER_TARGET_RESOLUTIONS: ReadonlySet<TargetResolution> = new Set<TargetResolution>([
  "order-most-recent",
  "order-named-reference",
  "order-display-reference",
]);

/** Kinds whose ctx is built by `loadOrderCtx` (resolved by id, ownership-confirming). */
export const ORDER_BY_ID_KINDS: ReadonlySet<string> = derivedKindSet(
  (p) => p.ctxLoader === "order-by-id",
);

/** Order/booking intents whose implicit ORDER target is auto-resolved. */
export const ORDER_AUTORESOLVE_KINDS: ReadonlySet<string> = derivedKindSet((p) =>
  ORDER_TARGET_RESOLUTIONS.has(p.targetResolution),
);

/** BKL-216 — the amend kinds that honour an EXPLICITLY-NAMED order first. */
export const ORDER_NAMED_REFERENCE_KINDS: ReadonlySet<string> = derivedKindSet(
  (p) => p.targetResolution === "order-named-reference",
);

/** FE-T14 — the booking intents whose implicit RESERVATION target is auto-resolved. */
export const RESERVATION_AUTORESOLVE_KINDS: ReadonlySet<string> = derivedKindSet(
  (p) => p.targetResolution === "reservation-active",
);

/** FE-D27 — the kinds whose `timeSlotId` may be grounded from an NL date/time pair. */
export const RESERVATION_SLOT_RESOLVE_KINDS: ReadonlySet<string> = derivedKindSet(
  (p) => p.slotResolution === "create-keys",
);

/** 034-F1 — the refund kinds that bind an owning orderId from their paymentId. */
export const REFUND_OWNERSHIP_KINDS: ReadonlySet<string> = derivedKindSet(
  (p) => p.ownershipBinding === "refund-payment-order",
);

/** The kinds whose adjudication reads the customer's PREVIOUS order. */
export const PREVIOUS_ORDER_CTX_KINDS: ReadonlySet<string> = derivedKindSet((p) =>
  p.ctxProjections.includes("previous-order"),
);

/** LE2-023 — the kinds whose adjudication reads a COUPON against the previous order. */
export const COUPON_SWAP_CTX_KINDS: ReadonlySet<string> = derivedKindSet((p) =>
  p.ctxProjections.includes("coupon-swap"),
);

/**
 * The kinds `confirmOnAutoResolveGuard` REQUEST_CONFIRMATIONs — re-exported by
 * `compose-policy-packs.ts` under its historical name.
 *
 * Before R3-S3 this was a hand-written set in that file, documented to "MUST
 * mirror ORDER_AUTORESOLVE_KINDS + RESERVATION_AUTORESOLVE_KINDS" — two
 * declarations of one fact, which R3-S1 could only pin with a test after finding
 * a copy had already drifted. Now both sides read the same rows.
 *
 * The lockstep contract is NOT thereby made vacuous, because this set and the two
 * auto-resolve sets are derived from DIFFERENT FIELDS (`confirmOnAutoResolve` vs
 * `targetResolution`). A row declaring an auto-resolve strategy with
 * `confirmOnAutoResolve: false` is expressible and would break the contract —
 * which is exactly the drift the lockstep exists to catch, now catchable at the
 * one place the fact is written.
 */
export const AUTORESOLVE_CONFIRM_KINDS: ReadonlySet<string> = derivedKindSet(
  (p) => p.confirmOnAutoResolve,
);
