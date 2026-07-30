/**
 * resolve-and-assemble — the ONE state contract shared by the conductor's
 * pre-adjudication resolve stage AND the HTTP customer-intent routes.
 *
 * Turns a conductor/HTTP intent into the per-pack `SystemState.ctx` the kernel
 * guards read, loaded READ-ONLY from the same domain services the tool handlers
 * use, so the kernel adjudicates commerce mutations against real entity state
 * instead of a stub (which made pack stateGuards panic-REFUSE).
 *
 * Split design:
 *  - `build*Ctx(base, data)` — PURE (no I/O). HTTP routes that already loaded the
 *    entity for their own logic call these directly (no redundant query).
 *  - `load*Ctx(base, …)` — loads the entity (scoped to the customer) then builds.
 *  - `resolveAndAssemble(args)` — the CONDUCTOR entry: builds the identity base,
 *    adds the F4 `sessionTokensConsumed` (conductor-only — HTTP is not LLM-token-
 *    gated), and dispatches by kind to the right `load*Ctx`.
 *
 * Invariants:
 *  - READ-ONLY; every load scoped to `customerId` (money-safety: a customer can
 *    never adjudicate against another principal's entity).
 *  - Fail-CLOSED, never panic: `ctx` ALWAYS exists; unresolved/cross-customer/
 *    not-found → null ctx fields → the owning pack's stateGuards REFUSE cleanly.
 */

import { getRedisClient, rk, medusaAdmin, medusaStore, reaisToCentavos, searchProducts } from "@ibatexas/tools";
import { Channel, type OrderEventItem } from "@ibatexas/types";
// LE2-023 — the pack's OWN money/PONR sets, so the feasibility projection and
// the guards that will adjudicate the cancel read ONE transcription. See each
// set's comment in `packages/pack-orders/src/policies.ts` for why a host-side
// copy would be a real defect rather than a style point.
import {
  CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES,
  CUSTOMER_POST_PONR_FULFILLMENT,
} from "@ibatexas/pack-orders";
import {
  createOrderQueryService,
  createOrderService,
  createPaymentQueryService,
  createCustomerService,
  createReservationService,
  prisma,
} from "@ibatexas/domain";
import { parseAgentSessionNamespace } from "./agent-guards.js";
// LE2-021 — the single owner-scoped "last order" read, shared with the
// workflow-scoped reorder handler so the confirm and the act cannot name
// different orders.
import { loadPreviousOrder, type PreviousOrder } from "./previous-order.js";
import { projectCouponForOrder } from "./coupon-price-projection.js";
// FE-T13 — reuse the ops-plane displayId parser (pure, no ops-specific
// dependency) rather than re-deriving the same `#1234`-style parse rule.
import { matchNamedOwnedOrders, parseDisplayIdRef } from "../ops/ops-order-resolution.js";
// BKL-140 — reuse the SINGLE non-terminal-stage set the discovery-fallback read
// already uses (turn-reads.ts), rather than re-deriving a byte-parallel copy
// (FE-D07 duplication lesson). No cycle: turn-reads never imports this module.
import { ACTIVE_FULFILLMENT_STAGES } from "./turn-reads.js";

/**
 * Per-session LLM-token Redis counter key. Single source of truth (write side:
 * emitTurn). Two identity shapes share this key builder:
 *  - conversational turns — identity slot = customerId (F4 / ADR-120);
 *  - managed-agent capsules (T3-4) — identity slot = the UNHASHED agent
 *    namespace `agent:<id>@<version>` (D-017), aggregating every entity
 *    capsule the agent opens on that channel into one meter. The agent host
 *    (T3-2 trigger bridge) MUST fold agent-turn usage into
 *    `sessionTokenKey(channel, <agent namespace>)` for the per-agent
 *    over-budget ESCALATE guard (agent-guards.ts) to see a real total.
 */
export function sessionTokenKey(channel: string, customerId: string): string {
  return rk(`llm:tokens:${channel}:${customerId}`);
}

function isGuestCustomerId(customerId: string): boolean {
  return /^(guest|anon|anonymous):/i.test(customerId);
}

/** Best-effort read of the per-session token total. Fail-open to 0 (conductor-only). */
async function readSessionTokensConsumed(
  channel: string,
  customerId: string,
): Promise<number> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(sessionTokenKey(channel, customerId));
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export type Ctx = Record<string, unknown>;
export interface AssembledResolution {
  readonly payload: unknown;
  readonly ctx: Ctx;
  /**
   * Resource ids the customer was OWNERSHIP-CONFIRMED to own this turn (the
   * customer-scoped DB load actually returned the row). Feeds the kernel
   * authority graph (034-F1) so the ownership guard binds ONLY real-owned
   * resources — a forged/other-principal id is never in this set, so the guard
   * REFUSEs rather than vacuously passing. Empty for non-resource (cart/draft) ops.
   */
  readonly owned: readonly string[];
  /**
   * 034-F1 (review finding 11): TRUE when an ownership-confirmable load
   * (loadOrderCtx / loadPaymentCtx) could NOT determine ownership because the
   * scoped DB read threw (resolved orderId present, but `resourceOwnerConfirmed`
   * left undefined). DISTINCT from "confirmed not owned" (`owned = []`, which
   * correctly REFUSEs a forged/cross-principal id): on an indeterminate result
   * the resolver must NOT engage the kernel guard, else a transient DB hiccup
   * REFUSEs the resource's TRUE owner. Service-layer scoping still applies.
   */
  readonly ownershipIndeterminate: boolean;
}

const KERNEL_TENANT_ID = (): string => process.env.KERNEL_TENANT_ID ?? "ibatexas";

/**
 * Universal identity/auth base every ctx carries. tenantId (requireTenantBinding,
 * all packs) + actor (payments/customer-onboarding) + channel/customer identity
 * (orders/reservations/whatsapp). NO F4 token here — that is conductor-only.
 * Exported so HTTP routes share the exact same base.
 */
export function identityCtx(customerId: string, channel: string): Ctx {
  const isAuthenticated = !isGuestCustomerId(customerId);
  return {
    tenantId: KERNEL_TENANT_ID(),
    channel,
    customerId: isAuthenticated ? customerId : null,
    staffId: channel === "staff" ? customerId : null,
    isAuthenticated,
    actor: { principal: channel === "staff" ? "staff" : "user", id: customerId },
    now: null as Date | null,
  };
}

// ── Orders (by id: cancel / amend / note / review / address.change / type.switch) ─
export interface OrderProjectionLite {
  readonly customerId: string;
  readonly paymentMethod?: string | null;
  readonly paymentStatus?: string | null;
  readonly totalInCentavos?: number;
  readonly fulfillmentStatus?: string;
}

/** PURE: project a (customer-owned) order row → orders ctx. `order` null → empty projection. */
export function buildOrderCtx(
  base: Ctx,
  orderId: string | null,
  order: OrderProjectionLite | null,
): Ctx {
  const ctx: Ctx = {
    ...base,
    cartId: null,
    orderId,
    items: undefined,
    fulfillment: null,
    paymentMethod: order ? (order.paymentMethod as string | null) ?? null : null,
    paymentStatus: order ? order.paymentStatus ?? null : null,
    totalInCentavos: order ? order.totalInCentavos : undefined,
    fulfillmentStatus: order ? order.fulfillmentStatus : undefined,
    lastAction: null,
    // 034-F1: a non-null order here means loadOrderCtx confirmed the customer
    // owns it (order.customerId === customerId). Drives the authority graph.
    resourceOwnerConfirmed: order !== null,
  };
  return ctx;
}

export async function loadOrderCtx(
  base: Ctx,
  customerId: string,
  orderId: string | null,
): Promise<Ctx> {
  if (orderId === null) return buildOrderCtx(base, null, null);
  try {
    // Customer-scoped read (SDD §N P0-3): getById enforces ownership at the
    // domain layer (non-owner / null-owner → null). The post-check below is
    // retained as defense-in-depth.
    const order = await createOrderQueryService().getById(orderId, { customerId });
    // Money-safety: never expose another customer's order to the guards.
    if (order?.customerId !== customerId) return buildOrderCtx(base, orderId, null);
    return buildOrderCtx(base, orderId, order as unknown as OrderProjectionLite);
  } catch {
    // 034-F1 (finding 11): ownership INDETERMINATE on a DB error — distinct from
    // the confirmed-not-owned path above (which sets resourceOwnerConfirmed=false).
    // Leave it undefined so the resolver keeps the guard inert (no false REFUSE of
    // the TRUE owner); service-layer scoping still applies.
    const c = buildOrderCtx(base, orderId, null);
    c.resourceOwnerConfirmed = undefined;
    return c;
  }
}

// ── Payments (payment.* targeting an order's active payment) ─────────────────
const TERMINAL_PAYMENT_STATUSES = new Set([
  "refunded",
  "pay_canceled",
  "canceled",
  "waived",
  "payment_failed",
  "payment_expired",
]);

export interface ActivePaymentLite {
  readonly status: string;
  readonly method: string;
  readonly version?: number;
  readonly refundedAmountCentavos?: number;
  readonly amountInCentavos?: number;
  readonly regenerationCount?: number;
}

/** PURE: project the active payment (+ all-attempts regen sum) → payments ctx. */
export function buildPaymentCtx(
  base: Ctx,
  orderId: string | null,
  data: { active: ActivePaymentLite; regenerationSum: number } | null,
): Ctx {
  if (data === null) {
    return {
      ...base,
      orderId,
      exists: false,
      currentStatus: undefined,
      currentMethod: undefined,
      version: undefined,
      isTerminal: undefined,
      refundedAmountCentavos: undefined,
      amountInCentavos: undefined,
      regenerationCount: undefined,
    };
  }
  const { active, regenerationSum } = data;
  return {
    ...base,
    orderId,
    exists: true,
    currentStatus: active.status,
    currentMethod: active.method,
    version: active.version,
    isTerminal: TERMINAL_PAYMENT_STATUSES.has(active.status),
    refundedAmountCentavos: active.refundedAmountCentavos ?? 0,
    amountInCentavos: active.amountInCentavos,
    regenerationCount: regenerationSum,
    // D1 (SDD §5 fresh conjunct / §G sourceMode==live): buildPaymentCtx is only
    // ever called with an active payment the caller read LIVE this turn (loadPayment
    // Ctx's customer-scoped DB read; HTTP routes pass their own fresh read). Stamp
    // the must_read_this_turn marker so the pack's refund-freshness guard can bind.
    paymentReadThisTurn: true,
  };
}

export async function loadPaymentCtx(
  base: Ctx,
  customerId: string,
  orderId: string | null,
): Promise<Ctx> {
  if (orderId === null) return buildPaymentCtx(base, null, null);
  // 034-F1: payment ownership flows through the order. `owned` records whether
  // this customer owns the order, INDEPENDENT of whether an active payment exists
  // (an owned order with no active payment is still owned) — drives the authority
  // graph without conflating "not owned" with "no payment".
  const notOwned = (): Ctx => {
    const c = buildPaymentCtx(base, orderId, null);
    c.resourceOwnerConfirmed = false;
    return c;
  };
  try {
    // Ownership gate: the order must belong to the customer before its payment is
    // read. Customer-scoped getById (SDD §N P0-3) enforces this at the domain
    // layer; the post-check below is retained as defense-in-depth.
    const order = await createOrderQueryService().getById(orderId, { customerId });
    if (order?.customerId !== customerId) return notOwned();
    const querySvc = createPaymentQueryService();
    // The active-payment read and the all-attempts read are both keyed only on
    // orderId and independent — fire them concurrently (finding 28). `all` feeds
    // regenerationSum, used only when an active payment exists (we ignore it below
    // when there is none).
    const [active, all] = await Promise.all([
      querySvc.getActiveByOrderId(orderId).catch(() => null),
      querySvc.listByOrderId(orderId).catch(() => null),
    ]);
    if (!active) {
      const c = buildPaymentCtx(base, orderId, null);
      c.resourceOwnerConfirmed = true; // order owned; just no active payment
      return c;
    }
    const regenerationSum = all
      ? all.payments.reduce(
          (s, p) => s + ((p as { regenerationCount?: number }).regenerationCount ?? 0),
          0,
        )
      : (active as { regenerationCount?: number }).regenerationCount ?? 0;
    const c = buildPaymentCtx(base, orderId, {
      active: active as unknown as ActivePaymentLite,
      regenerationSum,
    });
    c.resourceOwnerConfirmed = true;
    return c;
  } catch {
    // 034-F1 (finding 11): ownership INDETERMINATE on a DB error — NOT notOwned()
    // (which sets false → REFUSE). Leave undefined so the resolver keeps the guard
    // inert rather than REFUSE-ing the TRUE owner on a transient read failure.
    const c = buildPaymentCtx(base, orderId, null);
    c.resourceOwnerConfirmed = undefined;
    return c;
  }
}

// ── Cart / order-draft (order.cart.* / order.item.* / order.checkout.* / order.coupon.*) ─
interface MedusaCartLine {
  readonly variant_id: string;
  readonly quantity: number;
  readonly unit_price: number;
}
interface MedusaCartShape {
  readonly items?: ReadonlyArray<MedusaCartLine>;
  readonly total?: number;
  readonly completed_at?: string | null;
}
export interface CartLite {
  readonly cartId: string;
  readonly cart: MedusaCartShape | null;
}

/** PURE: project a cart (+ payload-supplied method/fulfillment) → orders cart ctx. */
export function buildCartCtx(base: Ctx, payload: Ctx, cart: CartLite | null): Ctx {
  const pm = payload.paymentMethod;
  const fulfillmentRaw = payload.deliveryType ?? payload.fulfillment;
  const ctx: Ctx = {
    ...base,
    cartId: cart?.cartId ?? null,
    orderId: null,
    items: undefined,
    fulfillment:
      fulfillmentRaw === "pickup" || fulfillmentRaw === "delivery" ? fulfillmentRaw : null,
    paymentMethod: pm === "pix" || pm === "card" || pm === "cash" ? pm : null,
    paymentStatus: null,
    totalInCentavos: undefined,
    lastAction: null,
  };
  const c = cart?.cart;
  if (c && !c.completed_at) {
    ctx.items = (c.items ?? []).map((i) => ({
      variantId: i.variant_id,
      quantity: i.quantity,
      priceInCentavos: reaisToCentavos(i.unit_price),
    }));
    ctx.totalInCentavos = reaisToCentavos(c.total ?? 0);
  }
  return ctx;
}

/**
 * The kinds whose adjudication reads the customer's PREVIOUS order.
 *
 * A named set rather than an `order.`-prefix test: every other order kind pays a
 * Prisma round-trip for nothing, and the reorder-last anchor is the only act
 * whose guard has any use for last-order state. Mirrors the shape of
 * `ORDER_BY_ID_KINDS` above.
 */
export const PREVIOUS_ORDER_CTX_KINDS: ReadonlySet<string> = new Set([
  "order.reorder.request",
  // LE2-023 — the swap-for-coupon anchor reads the SAME projection, and reads
  // more of it: `confirmSwapForCoupon` needs the total to quote, the display id
  // to name the order, and the two derived booleans
  // (`previousOrderIsCancelable`, `previousOrderPaymentIsSettled`) that decide
  // whether the route is possible and whether its refund clause is true.
  "order.coupon.swap.request",
  // LE2-024 — the paid-cancel anchor reads the same projection again, and reads
  // it for the same three decisions `confirmPaidCancel` makes: is there an order
  // (`previousOrderId`), may it still be cancelled (`previousOrderIsCancelable`),
  // and does cancelling it move money (`previousOrderPaymentIsSettled` +
  // `previousOrderTotalInCentavos`, the figure the confirm sentence quotes).
  "order.cancel.request",
]);

/**
 * LE2-021 — PURE: the four `previousOrder*` fields for a projected last order,
 * or `{}` when there is none.
 *
 * ADDITIVE by design. It is spread ONTO whatever ctx the kind's own loader
 * already produced rather than replacing it, so no existing guard loses an input
 * it would otherwise have had — `deferOnPendingPix`, `requireCheckoutEligibility`
 * and the rest still see exactly the state a cart-shaped order kind always sees.
 * This route only ADDS information to the chain; it removes none.
 *
 * Absence is a DECISION, not a gap: `confirmReorderLast` reads exactly these
 * fields and REFUSEs honestly ("ainda não encontrei nenhum pedido anterior seu
 * pra repetir") when any is missing, so an unwired host, an unauthenticated
 * caller, a first-time customer and a failed read all converge on the same safe
 * sentence instead of on a confirmation for a basket nobody could name.
 */
export function previousOrderCtxFields(previous: PreviousOrder | null): Ctx {
  if (previous === null) return {};
  return {
    previousOrderId: previous.orderId,
    previousOrderDisplayId: previous.displayId,
    previousOrderTotalInCentavos: previous.totalInCentavos,
    previousOrderItems: previous.items,
    // LE2-023 — the two DERIVED booleans the swap-for-coupon route branches on
    // and its confirm sentence states.
    //
    // Derived HERE, once, from the pack's OWN exported sets, so the pre-check
    // that decides whether to offer the workflow and the guard that will decide
    // whether to allow the cancel cannot disagree. `requireCancellable` is
    // additionally lenient when the status is unreadable (it returns true rather
    // than refuse a caller carrying no order state); this projection is NOT —
    // an unreadable status leaves `previousOrderIsCancelable` false and the
    // workflow simply is not offered. The asymmetry is correct in both
    // directions: a guard must not refuse a legitimate direct cancel over a
    // missing projection field, and a workflow must not OFFER to cancel
    // something it could not read.
    previousOrderIsCancelable:
      previous.fulfillmentStatus !== "" &&
      !CUSTOMER_POST_PONR_FULFILLMENT.has(previous.fulfillmentStatus),
    previousOrderPaymentIsSettled:
      previous.paymentStatus !== null &&
      CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES.has(previous.paymentStatus),
  };
}

/**
 * LE2-021 — stamp the previous-order fields onto a resolved ctx, in place.
 *
 * Gated on `isAuthenticated` the same way `loadCustomerCtx` is, and for the same
 * reason rather than as an optimisation: an unauthenticated caller has no
 * `customerId` an owner-scoped read could mean, so the query could only ever
 * return nothing. Skipping it keeps the guest path free of a pointless
 * round-trip AND keeps "this read is owner-scoped" true of every call rather
 * than true-because-the-filter-matched-nothing.
 *
 * Works identically on the RESUME path. `enrichResumeState` calls
 * `resolveAndAssemble` with no `sessionId` and no `utteranceText`, and this read
 * needs neither — only `customerId` — so the confirming turn's fresh
 * adjudication sees the previous order exactly as the selecting turn did. That
 * matters: the receipt only satisfies the "ask first" threshold, every guard
 * re-runs, and a `confirmReorderLast` that could not see the projection on
 * resume would REFUSE the customer's own "sim".
 */
async function stampPreviousOrderCtx(
  ctx: Ctx,
  base: Ctx,
  kind: string,
  customerId: string,
): Promise<void> {
  if (!PREVIOUS_ORDER_CTX_KINDS.has(kind)) return;
  if (base.isAuthenticated !== true) return;
  Object.assign(ctx, previousOrderCtxFields(await loadPreviousOrder(customerId)));
}

/** The kinds whose adjudication reads a COUPON against the previous order. */
const COUPON_SWAP_CTX_KINDS: ReadonlySet<string> = new Set([
  "order.coupon.swap.request",
]);

/**
 * LE2-023 — stamp the three coupon fields `confirmSwapForCoupon` reads.
 *
 * Runs AFTER {@link stampPreviousOrderCtx} and depends on it: the new total is
 * the PREVIOUS ORDER's total minus the promotion's discount, so the order this
 * projection prices is the one that projection just resolved. Sequencing it the
 * other way would price a coupon against `undefined` and stamp no total, which
 * the guard would then refuse — a silent, always-on failure of exactly the kind
 * `predicate-fact-unknown` exists to prevent one layer up.
 *
 * ── WHY THE CODE COMES OFF THE PAYLOAD AND THE SPELLING DOES NOT ────────────
 *
 * The code is a customer-authored SLOT, so the payload is the only place it can
 * come from — there is no owner-scoped read that could produce "the coupon this
 * customer meant". What does NOT come off the payload is the spelling the guard
 * quotes: `projectCouponForOrder` returns the code the STORE matched, which
 * differs whenever the customer typed lower case, and quoting the store's own
 * spelling keeps an untrusted string out of the one sentence the customer
 * approves a cancellation against.
 *
 * BEST-EFFORT and total, like every other stamp here: `projectCouponForOrder`
 * swallows its own IO failure and returns `{}`, so a Medusa outage leaves every
 * coupon field ABSENT, the guard refuses honestly, and nothing destructive runs.
 */
async function stampCouponSwapCtx(
  ctx: Ctx,
  base: Ctx,
  kind: string,
  payload: Ctx,
): Promise<void> {
  if (!COUPON_SWAP_CTX_KINDS.has(kind)) return;
  if (base.isAuthenticated !== true) return;
  const code = typeof payload.code === "string" ? payload.code : "";
  if (code === "") return;
  const total = ctx.previousOrderTotalInCentavos;
  Object.assign(
    ctx,
    await projectCouponForOrder({
      code,
      orderTotalInCentavos: typeof total === "number" ? total : undefined,
    }),
  );
}

async function loadCart(cartId: string): Promise<CartLite> {
  try {
    const data = (await medusaStore(`/store/carts/${cartId}`)) as { cart?: MedusaCartShape };
    return { cartId, cart: data.cart ?? null };
  } catch {
    return { cartId, cart: null };
  }
}

export async function loadCartCtx(
  base: Ctx,
  payload: Ctx,
  opts: { sessionId?: string; cartId?: string },
): Promise<Ctx> {
  // HTTP supplies cartId explicitly; the conductor resolves it from the session key.
  let cartId = opts.cartId ?? null;
  if (cartId === null && opts.sessionId !== undefined) {
    try {
      const redis = await getRedisClient();
      cartId = await redis.get(rk(`cart:active:session:${opts.sessionId}`));
    } catch {
      cartId = null;
    }
  }
  if (cartId === null) return buildCartCtx(base, payload, null);
  return buildCartCtx(base, payload, await loadCart(cartId));
}

/**
 * FE-T09b review fix (MAJOR-1) — "does this session have a cart with items
 * in it RIGHT NOW?" Reuses the exact same BKL-028 active-cart key + fetch
 * as `loadCartCtx` (never a second source of truth for "what is the
 * active cart"). Exported for `amend-preference-correction.ts`'s
 * both-states disambiguation: a bare "no pedido" reference from a
 * mid-cart customer ("põe mais uma coca no pedido") colloquially means
 * their IN-PROGRESS cart, not a placed order — favor the cart. Fail-
 * CLOSED to `false` (no cart) on any read error, same posture as
 * `loadCartCtx` itself.
 */
/**
 * The cart id this session is currently working on, or `undefined` — LE2-023.
 *
 * The same `rk("cart:active:session:<sessionId>")` key `loadCartCtx` reads and
 * `getOrCreateCart` / `order.reorder`'s handler write. Exported so the workflow
 * composition can stamp a `cartId` onto an activity payload without opening a
 * FOURTH inline copy of the key string in this file — the drift that Hard Rule
 * #7 and the shared `rk()` helper exist to prevent.
 *
 * FAIL-CLOSED to `undefined` on any read error, the same posture as
 * `loadCartCtx` and `hasNonEmptyActiveCart`: an unresolvable cart makes the
 * guard REFUSE, which is an honest stop rather than a mutation aimed at a cart
 * nobody could name.
 */
export async function readSessionCartId(
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  try {
    const redis = await getRedisClient();
    const cartId = await redis.get(rk(`cart:active:session:${sessionId}`));
    return cartId === null || cartId === "" ? undefined : cartId;
  } catch {
    return undefined;
  }
}

export async function hasNonEmptyActiveCart(sessionId: string | undefined): Promise<boolean> {
  if (sessionId === undefined) return false;
  try {
    const redis = await getRedisClient();
    const cartId = await redis.get(rk(`cart:active:session:${sessionId}`));
    if (cartId === null) return false;
    const { cart } = await loadCart(cartId);
    return cart !== null && !cart.completed_at && (cart.items?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── Reservations (reservation.* targeting a slot / existing reservation) ─────
function slotFromRow(
  row: { id: string; date: Date; startTime: string; maxCovers: number; reservedCovers: number } | null,
): Ctx | null {
  if (!row) return null;
  return {
    timeSlotId: row.id,
    startAt: new Date(`${row.date.toISOString().split("T")[0]}T${row.startTime}:00`),
    maxCovers: row.maxCovers,
    reservedCovers: row.reservedCovers,
  };
}

async function loadSlot(timeSlotId: string): Promise<Ctx | null> {
  const row = await prisma.timeSlot.findUnique({ where: { id: timeSlotId } }).catch(() => null);
  return slotFromRow(row);
}

export async function loadReservationCtx(
  base: Ctx,
  customerId: string,
  payload: Ctx,
): Promise<Ctx> {
  const reservationId = typeof payload.reservationId === "string" ? payload.reservationId : null;
  const timeSlotId = typeof payload.timeSlotId === "string" ? payload.timeSlotId : null;
  const newTimeSlotId = typeof payload.newTimeSlotId === "string" ? payload.newTimeSlotId : null;
  const ctx: Ctx = {
    ...base,
    now: new Date(),
    reservation: null,
    slot: null,
    newSlot: null,
    // customer no-show/blocked is a lenient signal (guards skip on absent); a
    // customer-stats load is a documented follow-up.
    customer: null,
  };
  try {
    if (reservationId !== null) {
      // getById is customer-scoped (throws/!owned → caught → reservation null → REFUSE).
      const r = await createReservationService().getById(reservationId, customerId).catch(() => null);
      if (r) {
        ctx.reservation = {
          id: r.id,
          status: r.status,
          partySize: r.partySize,
          timeSlotId: r.timeSlot.id,
        };
        ctx.slot = await loadSlot(r.timeSlot.id);
      }
    } else if (timeSlotId !== null) {
      ctx.slot = await loadSlot(timeSlotId);
    }
    if (newTimeSlotId !== null) ctx.newSlot = await loadSlot(newTimeSlotId);
  } catch {
    // Fail-closed.
  }
  return ctx;
}

// ── Customer onboarding (preferences / pix / anonymize) ──────────────────────
export interface CustomerFlags {
  readonly customerExists: boolean;
  readonly otpFresh: boolean;
  readonly hasParkedAnonymize: boolean;
}

/** PURE: customer onboarding ctx from already-known flags. */
export function buildCustomerCtx(base: Ctx, flags: CustomerFlags): Ctx {
  return {
    ...base,
    customerExists: flags.customerExists,
    otpFresh: flags.otpFresh,
    hasParkedAnonymize: flags.hasParkedAnonymize,
    parkedAnonymizeAt: null,
    lastProfileUpdateAt: null,
    immediateErasure: false,
  };
}

export async function loadCustomerCtx(base: Ctx, customerId: string): Promise<Ctx> {
  const isAuthenticated = base.isAuthenticated === true;
  if (!isAuthenticated) {
    return buildCustomerCtx(base, {
      customerExists: false,
      otpFresh: false,
      hasParkedAnonymize: false,
    });
  }
  let customerExists = false;
  let otpFresh = false;
  let hasParkedAnonymize = false;
  try {
    const customer = await createCustomerService().getById(customerId).catch(() => null);
    customerExists = customer !== null && customer !== undefined;
  } catch {
    /* fail-closed */
  }
  try {
    const redis = await getRedisClient();
    otpFresh = (await redis.get(rk(`anonymize:otp_verified:${customerId}`))) !== null;
    hasParkedAnonymize = (await redis.get(rk(`anonymize:pending:${customerId}`))) !== null;
  } catch {
    /* fail-closed */
  }
  return buildCustomerCtx(base, { customerExists, otpFresh, hasParkedAnonymize });
}

interface ResolveArgs {
  readonly kind: string;
  readonly payload: Ctx;
  readonly customerId: string;
  readonly channel: string;
  /**
   * Conversation handle = the conductor's AgentContext.sessionId
   * (register-ibatexas-tool-packs.ts) → the active-cart Redis key. Cart kinds
   * need it; absent → no cart found → conservative ctx (guards REFUSE cleanly).
   */
  readonly sessionId?: string;
  /**
   * FE-T14 — the raw utterance text (`cognition.perception.text`,
   * ibatexas-resolver.ts — the SAME source `correctAmendPreference` already
   * reads). Used ONLY by the allergen-mention detector below
   * (customer.preferences.update); every other kind ignores it. Optional and
   * fail-closed-to-absent, mirroring `sessionId`'s own posture — a caller
   * that omits it (e.g. an HTTP route with no conductor cognition) simply
   * never trips the detector, never crashes.
   */
  readonly utteranceText?: string;
}

/**
 * FE-T14 — deterministic allergen-mention detector for
 * `customer.preferences.update` (mirrors amend-preference-correction.ts's
 * marker-pattern idiom, one seam over: detection here stamps a ctx flag a
 * composed ADOPTER guard interprets — refuseAllergenMentionGuard,
 * compose-policy-packs.ts — rather than resolving/re-routing anything
 * itself; the kernel stays the sole REFUSE authority, CLAUDE.md rule #9).
 *
 * Deliberately broad, not narrow: every Portuguese allergen-root word
 * (alergia, alérgico/a, alergênico, alergista, anafilaxia is a DIFFERENT
 * root so not covered — see the second pattern) shares the `alerg` stem,
 * so a single case-insensitive substring test catches the whole family
 * without a maintained word list. Over-triggering is the SAFE failure mode
 * here (a false-positive REFUSE just redirects to the explicit channel,
 * annoying but harmless); under-triggering would silently let an allergen-
 * shaped ask succeed as a no-op — the exact "dishonest success reply"
 * this detector exists to prevent.
 *
 * `al[eé]rg` (not a bare `alerg`): "alergia"/"alergênico"/"alergista" spell
 * the stem WITHOUT an accent, but "alérgico"/"alérgica" (the far more
 * common everyday adjective — "sou alérgico a amendoim") spell it WITH one
 * — a plain `/alerg/i` silently misses every adjective form.
 */
const ALLERGEN_MENTION_PATTERN = /al[eé]rg|anafil/i;

/** Pure — no IO/clock/RNG. Case-insensitive substring test. */
export function isAllergenMentionUtterance(text: string | undefined): boolean {
  return typeof text === "string" && ALLERGEN_MENTION_PATTERN.test(text);
}

/**
 * BKL-280 — the STAY-HOME / DELIVERY-REQUEST marker net, and the deterministic
 * detector `confirmDeliveryContradiction` (pack-orders/src/policies.ts) reads
 * through the `stayHomeDeliveryMarker` ctx flag stamped in `resolveAndAssemble`.
 *
 * ── WHAT DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * V7-proven (bkl278, 2026-07-27, epoch 54cf4353d5a32564): on the utterance
 * "não vou poder sair de casa hoje, fecha aí, pago em dinheiro na entrega" the
 * 4B emits `order.checkout.create {delivery_type: "pickup", payment_method:
 * "cash"}` — a VALID capability carrying a WRONG payload, so it EXECUTEs. The
 * customer who just said they cannot leave home is signed up to collect their
 * order in person. It reproduces under EVERY prompt arm measured (V1/V2/V5/V7/
 * V8/STOCK/PATCHED), so it is a decision-boundary binding failure, not a
 * persona bug — owner ruling 2026-07-27 chose OPTION B, a deterministic
 * pack-side contradiction guard, precisely because prompts cannot stabilize it
 * and a guard outside the model is inherited by every future engine.
 *
 * ── WHY A LITERAL MARKER NET AND NOT A CLASSIFIER ────────────────────────────
 *
 * The flag must be UNFORGEABLE by the model: it is derived here, at resolve
 * time, from the customer's OWN utterance text, and never from anything the
 * model emitted. A probabilistic detector would re-introduce the very failure
 * mode the guard exists to bound (SDD §H, data-independence). So the net is a
 * closed list of explicit literal substrings — no fuzzy matching, no stemming,
 * no scoring.
 *
 * ── WHY DIACRITICS ARE FOLDED (and why that is safe HERE) ────────────────────
 *
 * The evidence corpus is 100% accent-correct ("não" 2252 occurrences, "nao"
 * zero), but real WhatsApp customers type both. Folding NFD combining marks
 * lets ONE ASCII marker match both spellings instead of maintaining a
 * two-spelling table (the `al[eé]rg` lesson above, generalized). This is NOT
 * the `canonicalizeUtterance` seam — that one PRESERVES diacritics on purpose
 * because it disambiguates place names (Ibaté ≠ Ibate). Nothing here resolves
 * an entity; folding only widens a safety net, so a fold that over-matches
 * costs a question and never a wrong execution.
 *
 * ── HOW THE NET WAS SIZED (measured, not guessed) ────────────────────────────
 *
 * Swept against the LIVE catalog (Postgres :5433 — 283 product/category/
 * variant/ingredient rows: ZERO hits), 1439 real `conversation_messages`, and
 * 431 in-repo corpus utterances. Against the 26-case governance-tier
 * `order.checkout.create` extraction corpus the net scores 11/11 on the
 * delivery cases and 0/11 on the pickup cases — no false negatives, no false
 * positives. Two measured corrections are baked in and must not be reverted
 * without re-running that sweep:
 *   - the bare English "delivery" marker was REMOVED: its only corpus
 *     occurrence is the NEGATED "não quero delivery não, fecha em dinheiro,
 *     vou retirar" — a genuine pickup, which it turned into a false positive.
 *   - "receber em casa" was ADDED: "…gostaria de receber em casa" is a
 *     delivery checkout the first net silently missed (a false NEGATIVE, the
 *     expensive direction — a missed contradiction is a wrong EXECUTE).
 *
 * The asymmetry is deliberate and is the whole design rule here: a false
 * positive costs one extra question (annoying, safe); a false negative costs a
 * wrong executed checkout (the defect). Bias toward asking.
 */
function foldForMarkers(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * FAMILY A — explicit statements of being unable/unwilling to LEAVE THE HOUSE.
 * Negated-verb forms ("não vou poder sair") rather than a bare "sair de casa",
 * which a legitimate pickup customer could say ("vou sair de casa pra buscar").
 */
const STAY_HOME_MARKERS: readonly string[] = [
  "nao vou poder sair",
  "nao vou conseguir sair",
  "nao posso sair",
  "nao vou sair",
  "nao consigo sair",
  "nao da pra sair",
  "nao tenho como sair",
  "sem poder sair",
  "sem sair de casa",
  "estou em casa",
  "to em casa",
  "tou em casa",
  "fico em casa",
  "ficar em casa",
  "preso em casa",
  "presa em casa",
];

/**
 * FAMILY B — explicit asks to RECEIVE the order at an address. Phrase-level,
 * never the bare word "entrega": "endereço de entrega incorreto" (a cancel
 * reason) and "vocês entregam em Ibaté?" (a coverage question) both contain it
 * and neither is a delivery REQUEST.
 */
const DELIVERY_REQUEST_MARKERS: readonly string[] = [
  "na entrega",
  "pra entrega",
  "para entrega",
  "quero entrega",
  "queria entrega",
  "com entrega",
  "entregar aqui",
  "entregar em casa",
  "entrega em casa",
  "entregar na minha casa",
  "entrega na minha casa",
  "me entrega",
  "entrega pra mim",
  "manda pra minha casa",
  "manda pra casa",
  "manda aqui",
  "mandar aqui",
  "traz aqui",
  "trazer aqui",
  "trazer em casa",
  "receber em casa",
  "recebo em casa",
  "receber aqui",
  "aqui em casa",
  "na minha casa",
  "pra minha casa",
  "meu endereco",
];

/** The two families, as ONE closed list. Exported for the marker-table test. */
export const STAY_HOME_DELIVERY_MARKERS: readonly string[] = [
  ...STAY_HOME_MARKERS,
  ...DELIVERY_REQUEST_MARKERS,
];

/**
 * Pure — no IO/clock/RNG. TRUE when the utterance carries an explicit stay-home
 * OR delivery-request marker. Either family alone is sufficient: the second
 * V7-class failing row ("pode fechar, pago no pix e manda pra minha casa")
 * carries NO stay-home phrase and no `entrega*` token at all, so an
 * A-AND-B conjunction would miss it.
 */
export function hasStayHomeDeliveryMarker(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  const folded = foldForMarkers(text);
  return STAY_HOME_DELIVERY_MARKERS.some((m) => folded.includes(m));
}

// Order kinds resolved by id (→ loadOrderCtx, which confirms customer ownership
// and sets resourceOwnerConfirmed). 034-F1: every OWNERSHIP_GATED order kind MUST
// be here (or a payment.* kind, handled by loadPaymentCtx) — otherwise it falls to
// the cart loader, resourceOwnerConfirmed stays unset, `owned` is empty, and the
// kernel ownership guard REFUSEs the resource's TRUE owner. The granular amend
// kinds (add_item/update_qty/remove_item) require an orderId and amend an existing
// order, so they resolve by id exactly like order.amend.request. The
// ownership-coverage test guards this invariant against drift.
export const ORDER_BY_ID_KINDS = new Set([
  "order.cancel",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.note.add",
  "order.review.submit",
  "order.address.change",
  "order.type.switch",
]);

// Order/booking intents whose target ("meu pedido" / "minha reserva") the
// customer may leave implicit: when it was NOT given explicitly, auto-resolve to
// the customer's most-recent target and FORCE a REQUEST_CONFIRMATION (via the
// confirm-on-autoresolve guard) so a wrong guess can never auto-execute — the
// user sees the resolved target and confirms/denies. BKL-038 adds the in-flight
// modify kinds (amend/note/address/type) so "adiciona uma coca no meu pedido" /
// "muda o endereço do meu pedido" resolve to the most-recent order instead of
// dead-ending. MUST stay in lockstep with AUTORESOLVE_CONFIRM_KINDS
// (compose-policy-packs.ts): a kind auto-resolved here but not confirmed there
// would EXECUTE against a silently-guessed target.
//
// FE-T09 (D-a, the amend inversion): the granular amend kinds
// (add_item/update_qty/remove_item) are now MODEL-proposable — the model is
// never shown an `orderId` field (it is Identity-class, forbidden by
// `order-amend-granular.schema.ts`), so unlike the old assumption ("they
// carry an explicit orderId from the amend flow"), a model-driven granular
// amend needs the SAME "most-recent order" auto-resolve `order.amend.request`
// already gets. Added here alongside it.
//
// R3-S1 — EXPORTED for the lockstep coverage contract
// (__tests__/autoresolve-confirm-lockstep.test.ts), exactly as
// `ORDER_BY_ID_KINDS` above is exported for the ownership-gating coverage
// contract. Before that test the lockstep above was comment-only: both sets
// were module-private, so nothing could compare them and the mirror had
// already drifted in a test's hand copy. Not part of the module's runtime API —
// production code must keep reading it through `applyAutoResolve`.
export const ORDER_AUTORESOLVE_KINDS = new Set([
  "order.cancel",
  "payment.pix.regenerate",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.note.add",
  "order.address.change",
  "order.type.switch",
  // FE-D28 — order.review.submit's orderId is Identity-class (never model-
  // emitted); the reviewed order is auto-resolved to the customer's most-recent
  // order (or an explicit `orderReference` display number — see
  // `applyAutoResolve`'s review special-case). Same confirm-first posture as
  // the modify kinds: the customer sees the resolved order + product before a
  // public review posts. MUST stay in lockstep with AUTORESOLVE_CONFIRM_KINDS.
  "order.review.submit",
]);

/**
 * BKL-216 — the AMEND kinds whose auto-resolve first honors an order the customer
 * EXPLICITLY NAMED in the message (`resolveAmendOrderReference`). The
 * mutation-plane sibling of BKL-203/#350: before this, every kind above
 * blind-resolved to the most-recent order, so "tira a coca do pedido 933869"
 * amended whichever order happened to be newest — the customer's named order was
 * read, then ignored.
 *
 * Scoped to `order.amend.*` ONLY — exactly the ticket. `order.cancel` /
 * `order.note.add` / `order.address.change` / `order.type.switch` /
 * `payment.pix.regenerate` keep the unchanged blind most-recent resolution behind
 * their confirm gate (widening the mutation-plane reference resolution to them is
 * BKL-198's row, not this one).
 */
const ORDER_NAMED_REFERENCE_KINDS = new Set([
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
]);
// FE-T14 — reservation.modify's schema never shows the model a
// `reservationId` field (Identity-class, forbidden) and, before this
// change, had NO auto-resolve path at all: `resolveReservationId` below is
// only invoked for kinds in this set, so `reservation.modify` could never
// reach a reservationId from chat despite being advertised
// (plannerAdvertisedBy, definitions.ts) and offered on the customer
// planner's allowed-intent set (surfaces.json) — a live, customer-facing
// gap. Added alongside reservation.cancel with IDENTICAL semantics: resolve
// to the customer's one active reservation when unambiguous (never a guess
// among several), forcing a confirm (AUTORESOLVE_CONFIRM_KINDS,
// compose-policy-packs.ts, mirrors this addition).
//
// R3-S1 — EXPORTED for the same lockstep coverage contract as
// `ORDER_AUTORESOLVE_KINDS` above: `AUTORESOLVE_CONFIRM_KINDS` is documented to
// mirror the UNION of the two, so the contract test needs both halves.
export const RESERVATION_AUTORESOLVE_KINDS = new Set(["reservation.cancel", "reservation.modify"]);

// FE-D27 — the kinds whose timeSlotId may be grounded from an NL date/time pair
// (the pure-chat "mesa pra 4 sexta às 20h" path) instead of a listed slot id.
// reservation.modify is handled separately (its slot key is `newTimeSlotId`).
const RESERVATION_SLOT_RESOLVE_KINDS = new Set([
  "reservation.create",
  "reservation.waitlist.join",
]);
/** The ISO calendar-date shape check_availability's own `date` field uses (YYYY-MM-DD). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 034-F1 (review finding 6/7): refund payloads (PaymentRefundIssuePayload /
// PaymentRefundConfirmPayload) carry ONLY paymentId — never orderId. Since
// ownership flows through the order, the kernel ownership guard had no resource to
// bind and ran INERT for every refund. These kinds resolve their owning orderId
// from the paymentId so loadPaymentCtx can confirm ownership and the authority
// graph engages. This is an ownership BINDING only — the refund target stays the
// explicit paymentId — so it does NOT force a confirm like the NL autoresolve path.
const REFUND_OWNERSHIP_KINDS = new Set(["payment.refund.issue", "payment.refund.confirm"]);

/**
 * NL→id: explicit orderId wins; else auto-resolve the customer's most-recent
 * order. Exported (FE-T13) so the customer-plane READ executors
 * (`check_order_status` / `get_payment_status`, claustrum-bootstrap.ts) can
 * reuse the SAME "most recent order" resolution the mutating
 * `ORDER_AUTORESOLVE_KINDS` path already relies on, rather than re-deriving a
 * byte-parallel copy — those two reads now forbid a model-facing `orderId`
 * field (Identity class, read-tool-schemas.ts), so they need the identical
 * auto-resolve fallback this function already gives `order.amend.*`/
 * `order.cancel`/etc. Passing `{}` (no explicit orderId) always takes the
 * auto-resolve branch, which is exactly what a read-tool call needs since its
 * schema can never carry one.
 */
export async function resolveOrderId(
  payload: Ctx,
  customerId: string,
): Promise<{ orderId: string | null; autoResolved: boolean }> {
  if (typeof payload.orderId === "string") {
    return { orderId: payload.orderId, autoResolved: false };
  }
  try {
    const { orders } = await createOrderQueryService().listByCustomer(customerId, {
      limit: 1,
    });
    const recent = orders[0] as { id?: string } | undefined;
    return recent?.id
      ? { orderId: recent.id, autoResolved: true }
      : { orderId: null, autoResolved: false };
  } catch {
    return { orderId: null, autoResolved: false };
  }
}

/**
 * FE-T13 — resolve `check_order_status`/`get_payment_status`'s optional
 * `orderReference` field (a display-number NL reference the customer may
 * name, e.g. "pedido 1234" / "#1234" — CHECK_ORDER_STATUS_READ_SCHEMA /
 * GET_PAYMENT_STATUS_READ_SCHEMA, read-tool-schemas.ts) to a concrete owned
 * orderId. Mirrors the ops-plane displayId resolution idiom
 * (`parseDisplayIdRef`, ops-order-resolution.ts) but customer-scoped: unlike
 * `OrderQueryService.findByDisplayId` (no owner scoping — the internal/staff
 * path), a match here is IDOR-checked against `customerId` before being
 * trusted, since a customer could name ANOTHER customer's display number.
 * Falls through to {@link resolveOrderId}'s "most recent order" auto-resolve
 * (unchanged) when: no reference was given, it doesn't parse as a display
 * number, or the parsed number matches no order owned by this customer —
 * never returns a foreign order, and never throws (a lookup failure degrades
 * to the auto-resolve fallback, fail-safe).
 */
/** A disambiguation candidate for the read executor's CLARIFY-shaped result. */
export interface OrderReferenceCandidate {
  readonly orderId: string;
  readonly displayId: number;
}

/**
 * The outcome of resolving a customer's order reference for a read tool. Adds two
 * BKL-140 fields to the FE-T13 shape (both default false/[]), so existing callers
 * that destructure `{ orderId }` are unaffected:
 *  - `ambiguous` — an id-less/date reference matched ≥2 owned orders; the executor
 *    returns a disambiguation-shaped result instead of silently guessing one.
 *  - `candidates` — the ambiguous orders' `{orderId, displayId}` (display numbers
 *    the CLARIFY copy can name).
 */
export interface ResolvedOrderReference {
  readonly orderId: string | null;
  readonly autoResolved: boolean;
  readonly referenceMatched: boolean;
  readonly ambiguous: boolean;
  readonly candidates: ReadonlyArray<OrderReferenceCandidate>;
}

const NO_ORDER_REFERENCE: ResolvedOrderReference = {
  orderId: null,
  autoResolved: false,
  referenceMatched: false,
  ambiguous: false,
  candidates: [],
};

/** The order-row fields the reference resolver reads (a narrow of OrderProjection). */
interface OrderRefRow {
  readonly id: string;
  readonly displayId: number;
  readonly fulfillmentStatus: string | null;
  readonly medusaCreatedAt: Date;
}

function toOrderCandidate(o: OrderRefRow): OrderReferenceCandidate {
  return { orderId: o.id, displayId: o.displayId };
}

/** The restaurant-timezone calendar day (`YYYY-MM-DD`) for an instant — the same
 *  `Intl` idiom the schedule/date-anchor code uses (schedule-date-resolver.ts). */
function restaurantDayStr(instant: Date | string): string {
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo";
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

/** Shift a `YYYY-MM-DD` calendar day by whole days (deterministic, TZ-free). */
function shiftDayStr(ymd: string, deltaDays: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// FE-D24 — pt-BR weekday markers → day-of-week (0=Sun … 6=Sat). Ordered for a
// stable scan; diacritic + `-feira`/plural variants explicit. Mirrors the
// schedule-date-resolver marker idiom, but this resolver looks BACKWARD (orders are
// past), where schedule-date-resolver looks forward (reservations are future).
const ORDER_WEEKDAY_MARKERS: ReadonlyArray<{ re: RegExp; dow: number }> = [
  { re: /\bdomingos?\b/i, dow: 0 },
  { re: /\bsegunda(?:s|-feiras?)?\b/i, dow: 1 },
  { re: /\bter[çc]a(?:s|-feiras?)?\b/i, dow: 2 },
  { re: /\bquarta(?:s|-feiras?)?\b/i, dow: 3 },
  { re: /\bquinta(?:s|-feiras?)?\b/i, dow: 4 },
  { re: /\bsexta(?:s|-feiras?)?\b/i, dow: 5 },
  { re: /\bs[áa]bados?\b/i, dow: 6 },
];

/**
 * FE-D24 — DETERMINISTIC (no model) parse of a relative-date order reference to the
 * restaurant-TZ calendar day (`YYYY-MM-DD`) it names, or null when the text carries
 * no recognized date marker. Backward-looking: "hoje"/"ontem"/"anteontem" and a
 * named weekday → its most-recent occurrence on-or-before today (orders are past).
 */
export function parseRelativeOrderDate(text: string): string | null {
  const today = restaurantDayStr(new Date());
  if (/\banteontem\b/i.test(text)) return shiftDayStr(today, -2);
  if (/\bontem\b/i.test(text)) return shiftDayStr(today, -1);
  if (/\bhoje\b/i.test(text)) return today;
  for (const { re, dow } of ORDER_WEEKDAY_MARKERS) {
    if (re.test(text)) {
      const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
      const offset = (todayDow - dow + 7) % 7; // 0 when today IS that weekday
      return shiftDayStr(today, -offset);
    }
  }
  return null;
}

/** Load the customer's own recent orders (owner-scoped → IDOR-closed), [] on error. */
async function loadCustomerOrderRows(customerId: string, limit: number): Promise<OrderRefRow[]> {
  try {
    const { orders } = await createOrderQueryService().listByCustomer(customerId, { limit });
    return orders as unknown as OrderRefRow[];
  } catch {
    return [];
  }
}

/**
 * BKL-140 — the id-less resolution: no display number, no date. Prefer the customer's
 * ONE active (non-terminal) order — the order they're almost certainly asking about;
 * ≥2 active → ambiguous (disambiguate, never guess); 0 active but orders exist → the
 * most-recent order (an honest "your last order …", unchanged from FE-T13); truly no
 * orders → the honest no-order result.
 */
function resolveIdless(orders: OrderRefRow[]): ResolvedOrderReference {
  const active = orders.filter((o) => ACTIVE_FULFILLMENT_STAGES.has(String(o.fulfillmentStatus)));
  if (active.length === 1) {
    return { ...NO_ORDER_REFERENCE, orderId: active[0]!.id, autoResolved: true };
  }
  if (active.length >= 2) {
    return { ...NO_ORDER_REFERENCE, ambiguous: true, candidates: active.map(toOrderCandidate) };
  }
  if (orders.length === 0) return NO_ORDER_REFERENCE;
  return { ...NO_ORDER_REFERENCE, orderId: orders[0]!.id, autoResolved: true };
}

/**
 * FE-T13 (+ BKL-140 / FE-D24) — resolve `check_order_status`/`get_payment_status`'s
 * optional `orderReference` field to a concrete OWNED orderId. Priority:
 *   1. a display number ("pedido 1234"/"#1234") → the order with that display id
 *      OWNED by this customer (IDOR-checked — a customer may name another's number).
 *   2. FE-D24 — a relative date ("de ontem"/"de terça", {@link parseRelativeOrderDate},
 *      deterministic) → the customer's own order(s) created that restaurant-TZ day
 *      (owner-scoped → IDOR-closed): exactly one → that order; ≥2 → ambiguous.
 *   3. BKL-140 — no resolvable reference → {@link resolveIdless} (one active order,
 *      else disambiguate/most-recent/no-order).
 * Every branch is customer-scoped, so a foreign order is NEVER returned; a lookup
 * error degrades to the id-less fallback (fail-safe), never throws.
 */
export async function resolveCustomerOrderReference(
  orderReference: string | undefined,
  customerId: string,
): Promise<ResolvedOrderReference> {
  if (typeof orderReference === "string") {
    // 1. Explicit display-number reference (IDOR-checked) — unchanged (FE-T13).
    const displayId = parseDisplayIdRef(orderReference);
    if (displayId !== null) {
      try {
        const candidates = await createOrderQueryService().findByDisplayId(displayId);
        const owned = candidates.find((o) => o.customerId === customerId);
        if (owned) {
          return { ...NO_ORDER_REFERENCE, orderId: owned.id, referenceMatched: true };
        }
      } catch {
        // Fail-safe — fall through, same posture as resolveOrderId's own try/catch.
      }
    }
    // 2. FE-D24 — a relative-date reference filters the customer's OWN orders by day.
    const targetDay = parseRelativeOrderDate(orderReference);
    if (targetDay !== null) {
      const rows = await loadCustomerOrderRows(customerId, 50);
      const onDay = rows.filter((o) => restaurantDayStr(o.medusaCreatedAt) === targetDay);
      if (onDay.length === 1) {
        return { ...NO_ORDER_REFERENCE, orderId: onDay[0]!.id, referenceMatched: true };
      }
      if (onDay.length >= 2) {
        return { ...NO_ORDER_REFERENCE, ambiguous: true, candidates: onDay.map(toOrderCandidate) };
      }
      // 0 orders that day → fall through to the id-less resolution below.
    }
  }
  // 3. BKL-140 — id-less active-order-aware resolution.
  return resolveIdless(await loadCustomerOrderRows(customerId, 20));
}

/** BKL-216 — the outcome of resolving an amend's target order. `orderId: null` with
 *  a non-empty `ambiguousDisplayIds` is the CLARIFY case; `autoResolved` marks the
 *  blind most-recent fallback (the only branch that forces a confirm). */
export interface ResolvedAmendOrderReference {
  readonly orderId: string | null;
  readonly autoResolved: boolean;
  /** The ≥2 OWNED display numbers the message named (CLARIFY case only). */
  readonly ambiguousDisplayIds: readonly number[];
}

/**
 * BKL-216 — the MUTATION-plane order-reference resolution for `order.amend.*`
 * ({@link ORDER_NAMED_REFERENCE_KINDS}). The sibling of the READ-plane BKL-203 fix
 * (#350): a customer who NAMES one of their orders must amend THAT order, not
 * whichever one is newest.
 *
 * Precedence, and what each branch preserves:
 *   1. an EXPLICIT `payload.orderId` wins, unchanged ({@link resolveOrderId}).
 *   2. the message names exactly ONE of the customer's OWN orders by display
 *      number → bind it. `autoResolved` is FALSE: nothing was guessed, so the
 *      confirm-on-autoresolve gate (whose shared prompt asserts "o seu pedido mais
 *      RECENTE" — compose-policy-packs.ts) must not fire and assert a falsehood
 *      about a named older order. This mirrors branch 1's posture for an explicit
 *      id, and it is NOT a money-safety relaxation: `order.amend.add_item` still
 *      confirms via its own `requireAmendItemDisambiguation` guard, and the Inv 11
 *      amount bands are untouched.
 *   3. the message names ≥2 of them → resolve NOTHING and stamp
 *      `orderReferenceAmbiguousCount` + `orderReferenceAmbiguousDisplayIds` so the
 *      pack-side `clarifyAmbiguousOrderReference` guard asks WHICH order (the
 *      BKL-223 reservation idiom). Never a guess between two named orders.
 *   4. no owned order is named → the pre-existing blind most-recent auto-resolve,
 *      byte-for-byte (`autoResolved: true` → the confirm still gates it).
 *
 * IDOR-safe BY CONSTRUCTION: the candidate set is `listByCustomer`'s owner-scoped
 * rows and the match runs through the SHARED {@link matchNamedOwnedOrders}, so a
 * message naming ANOTHER customer's display number matches nothing and lands in
 * branch 4 — it can never bind, and the customer still sees a confirm naming their
 * own resolved order before anything mutates. Fail-safe: a read error yields no
 * rows (`loadCustomerOrderRows`), i.e. the same `orderId: null` `resolveOrderId`
 * returns on a throw.
 */
export async function resolveAmendOrderReference(
  payload: Ctx,
  customerId: string,
  utteranceText: string | undefined,
): Promise<ResolvedAmendOrderReference> {
  if (typeof payload.orderId === "string") {
    return { orderId: payload.orderId, autoResolved: false, ambiguousDisplayIds: [] };
  }
  // Same owner-scoped read + limit the id-less read plane uses (resolveIdless), so
  // `rows[0]` IS the most-recent order branch 4 falls back to.
  const rows = await loadCustomerOrderRows(customerId, 20);
  const mostRecent: ResolvedAmendOrderReference = {
    orderId: rows[0]?.id ?? null,
    autoResolved: rows.length > 0,
    ambiguousDisplayIds: [],
  };
  if (typeof utteranceText !== "string" || utteranceText.trim() === "") {
    return mostRecent;
  }
  const named = matchNamedOwnedOrders(rows, utteranceText);
  if (named.length === 1) {
    return { orderId: named[0]!.id, autoResolved: false, ambiguousDisplayIds: [] };
  }
  if (named.length >= 2) {
    return {
      orderId: null,
      autoResolved: false,
      ambiguousDisplayIds: named.map((o) => o.displayId),
    };
  }
  return mostRecent;
}

/** 034-F1: resolve the orderId that OWNS a payment, for the refund ownership
 *  binding (finding 6/7). Fail-safe to null → resolver leaves the guard inert
 *  (service-layer scoping still applies) rather than REFUSE-ing on a read error. */
async function resolvePaymentOrderId(paymentId: string): Promise<string | null> {
  try {
    const payment = await createPaymentQueryService().getById(paymentId);
    return payment && typeof payment.orderId === "string" ? payment.orderId : null;
  } catch {
    return null;
  }
}

/**
 * BKL-223 — a deterministic, first-party label for an ambiguous reservation
 * candidate ("20/07 às 18h30"), composed from the DB timeSlot's OWN date +
 * startTime (never model-authored). Mirrors BKL-174's `slotAmbiguousTimes` but
 * carries the pre-composed string (a reservation needs date + time to
 * disambiguate, unlike a same-date slot which needs only the time).
 */
function reservationCandidateLabel(date: string, startTime: string): string {
  // date is ISO YYYY-MM-DD (DTO); render DD/MM. startTime is HH:MM → HHh / HHhMM.
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const dm = d === null ? date : `${d[3]}/${d[2]}`;
  const t = /^(\d{1,2}):(\d{2})$/.exec(startTime);
  const hm = t === null ? startTime : t[2] === "00" ? `${t[1]}h` : `${t[1]}h${t[2]}`;
  return `${dm} às ${hm}`;
}

/**
 * NL→id: explicit reservationId wins; else auto-resolve the customer's ONE active
 * reservation. BKL-223 — a THREE-way outcome (mirrors {@link resolveIdless} for
 * orders): resolved-one / AMBIGUOUS-many (carry first-party candidate labels for a
 * CLARIFY, never a guess) / none. Collapsing ≥2 into `reservationId:null` here would
 * — as before this fix — render `reservation.not_found` even though the reservations
 * WERE found; the pack-side `clarifyAmbiguousReservation` guard voices the candidates
 * instead. Owner-scoped (only THIS customer's reservations); fail-safe on read error.
 */
async function resolveReservationId(
  payload: Ctx,
  customerId: string,
): Promise<{ reservationId: string | null; autoResolved: boolean; ambiguousLabels?: string[] }> {
  if (typeof payload.reservationId === "string") {
    return { reservationId: payload.reservationId, autoResolved: false };
  }
  try {
    const { reservations } = await createReservationService().listByCustomer(customerId, {
      limit: 10,
    });
    const active = (
      reservations as Array<{
        id: string;
        status: string;
        timeSlot: { date: string; startTime: string };
      }>
    ).filter((r) => r.status === "pending" || r.status === "confirmed");
    if (active.length === 1) {
      return { reservationId: active[0]!.id, autoResolved: true };
    }
    if (active.length >= 2) {
      // ≥2 active → ambiguous: carry the first-party candidate labels for the CLARIFY
      // (never guess which one). The reservationId stays null so the slot/present
      // guards still fail closed; the clarify guard pre-empts the not_found refuse.
      return {
        reservationId: null,
        autoResolved: false,
        ambiguousLabels: active.map((r) =>
          reservationCandidateLabel(r.timeSlot.date, r.timeSlot.startTime),
        ),
      };
    }
    return { reservationId: null, autoResolved: false };
  } catch {
    return { reservationId: null, autoResolved: false };
  }
}

// ── resolveAndAssemble helpers (extracted to bound cognitive complexity) ──────

/**
 * T3-4 agent-session budget read: when the capsule runs under a managed-agent
 * sessionId (D-017 `agent:<id>@<ver>:entity:<entityId>`), read the agent-
 * namespace token counter (same llm:tokens key shape, identity slot = the agent
 * namespace — see sessionTokenKey) so the per-agent ESCALATE guard
 * (agent-guards.ts, AUTH phase) can meter off it. Returns undefined for a normal
 * (non-agent) conversational turn. Same fail-open-to-0 posture as the F4 read.
 */
async function readAgentSessionTokens(
  channel: string,
  sessionId: string | undefined,
): Promise<number | undefined> {
  if (sessionId === undefined) return undefined;
  const agentNamespace = parseAgentSessionNamespace(sessionId);
  if (agentNamespace === null) return undefined;
  return readSessionTokensConsumed(channel, agentNamespace);
}

/**
 * NL→id resolution (confirm-first): for irreversible money/booking intents whose
 * target wasn't given explicitly, auto-resolve it and flag the turn so the
 * confirm-on-autoresolve guard REQUEST_CONFIRMATIONs (the user sees the target).
 */
async function applyAutoResolve(
  kind: string,
  payload: Ctx,
  customerId: string,
  utteranceText: string | undefined,
): Promise<{ payload: Ctx; autoResolvedMoneyRef: boolean }> {
  if (ORDER_AUTORESOLVE_KINDS.has(kind)) {
    // FE-D28 — order.review.submit resolves its reviewed order via the FE-T13
    // display-number path: an explicit `orderReference` ("pedido 1234") is
    // looked up authoritatively + IDOR-checked, falling back to the customer's
    // most-recent order when absent/unmatched. Either way the turn confirms the
    // resolved target (a public review posts against it), so `autoResolvedMoneyRef`
    // is set whenever an order was resolved — not only on the blind fallback.
    if (kind === "order.review.submit") {
      const r = await resolveCustomerOrderReference(
        typeof payload.orderReference === "string" ? payload.orderReference : undefined,
        customerId,
      );
      if (r.orderId !== null) {
        return { payload: { ...payload, orderId: r.orderId }, autoResolvedMoneyRef: true };
      }
      return { payload, autoResolvedMoneyRef: false };
    }
    // BKL-216 — the amend kinds honor an EXPLICITLY-NAMED owned order before
    // falling back to the (unchanged) blind most-recent resolution. Every other
    // autoresolve kind keeps `resolveOrderId` verbatim.
    if (ORDER_NAMED_REFERENCE_KINDS.has(kind)) {
      const r = await resolveAmendOrderReference(payload, customerId, utteranceText);
      if (r.ambiguousDisplayIds.length >= 2) {
        // ≥2 OWNED orders named: stamp the ambiguity markers (the BKL-223 shape) so
        // the pack-side `clarifyAmbiguousOrderReference` guard asks which one. NOT an
        // autoresolve — orderId stays unstamped so `requireOrderIdForMutation` still
        // fails closed if the clarify guard is ever unwired.
        return {
          payload: {
            ...payload,
            orderReferenceAmbiguousCount: r.ambiguousDisplayIds.length,
            orderReferenceAmbiguousDisplayIds: [...r.ambiguousDisplayIds],
          },
          autoResolvedMoneyRef: false,
        };
      }
      if (r.orderId !== null) {
        return {
          payload: { ...payload, orderId: r.orderId },
          // A NAMED order was given, not guessed → no forced confirm (the shared
          // prompt would claim "mais recente"). Only the blind fallback confirms.
          autoResolvedMoneyRef: r.autoResolved,
        };
      }
      return { payload, autoResolvedMoneyRef: false };
    }
    const r = await resolveOrderId(payload, customerId);
    if (r.autoResolved && r.orderId !== null) {
      return { payload: { ...payload, orderId: r.orderId }, autoResolvedMoneyRef: true };
    }
  } else if (RESERVATION_AUTORESOLVE_KINDS.has(kind)) {
    const r = await resolveReservationId(payload, customerId);
    if (r.autoResolved && r.reservationId !== null) {
      return {
        payload: { ...payload, reservationId: r.reservationId },
        autoResolvedMoneyRef: true,
      };
    }
    // BKL-223 — ≥2 active reservations: stamp the ambiguity marker (mirrors
    // `resolveReservationSlot`'s `slotAmbiguous*`) so the pack-side
    // `clarifyAmbiguousReservation` guard voices the candidates as a CLARIFY
    // instead of a bare not_found REFUSE. NOT an autoresolve (no forced confirm) —
    // the reservationId stays unstamped so the present/slot guards fail closed.
    if (r.ambiguousLabels !== undefined && r.ambiguousLabels.length >= 2) {
      return {
        payload: {
          ...payload,
          reservationAmbiguousCount: r.ambiguousLabels.length,
          reservationAmbiguousLabels: r.ambiguousLabels,
        },
        autoResolvedMoneyRef: false,
      };
    }
  }
  return { payload, autoResolvedMoneyRef: false };
}

/**
 * FE-D27 — the party size to size availability against. create/waitlist carry a
 * required `partySize`; a modify may change only the time, so its size falls back to
 * the (already auto-resolved) reservation's own party size — a slot must fit the same
 * cover count. Returns undefined when no size can be established (→ no resolution,
 * honest refuse downstream).
 */
async function resolveSlotPartySize(
  kind: string,
  payload: Ctx,
  customerId: string,
): Promise<number | undefined> {
  if (kind === "reservation.modify") {
    if (typeof payload.newPartySize === "number") return payload.newPartySize;
    const rid = typeof payload.reservationId === "string" ? payload.reservationId : null;
    if (rid === null) return undefined;
    const r = await createReservationService().getById(rid, customerId).catch(() => null);
    return r && typeof r.partySize === "number" ? r.partySize : undefined;
  }
  return typeof payload.partySize === "number" ? payload.partySize : undefined;
}

/**
 * FE-D27 — NL slot-booking: ground an NL date (+optional time) to a REAL timeSlotId
 * so a pure-chat "mesa pra 4 sexta às 20h" can book without a prior check_availability
 * read. Reuses the SAME authoritative `checkAvailability` lookup (the availability
 * surface is PUBLIC — no IDOR; the reservation WRITE stays governed) with the
 * UTC-calendar-date discipline FE-D11 fixed. Only when the caller did NOT already pick
 * a listed slot:
 *   - exactly one available slot → stamp the slot key (authoritative);
 *   - ≥2 → stamp `slotAmbiguousCount` + `slotAmbiguousTimes` (the first-party candidate
 *     `startTime`s; mirrors the amend `itemAmbiguousCount` marker); the slot stays
 *     UNSTAMPED so the reservation guard REFUSEs, and the pack-side CLARIFY guard
 *     (BKL-174) names the candidate times instead of a bare slot-missing refuse;
 *   - 0 → payload unchanged (unstamped slot → the existing honest no-availability
 *     refuse). Fail-safe: a lookup error degrades to no resolution, never throws.
 * The date must be ISO (YYYY-MM-DD) — the shape check_availability's `date` field
 * already proves the 4B emits; a non-ISO value is left for the honest refuse (FE-D24's
 * relative parser is deliberately NOT reused here — it is BACKWARD-looking for past
 * orders, wrong for FUTURE reservations).
 */
export async function resolveReservationSlot(
  kind: string,
  payload: Ctx,
  customerId: string,
): Promise<Ctx> {
  const isCreate = RESERVATION_SLOT_RESOLVE_KINDS.has(kind);
  const isModify = kind === "reservation.modify";
  if (!isCreate && !isModify) return payload;

  const slotKey = isModify ? "newTimeSlotId" : "timeSlotId";
  const dateKey = isModify ? "newDate" : "date";
  const timeKey = isModify ? "newTime" : "time";
  // Already grounded (a listed slot was chosen) → nothing to resolve.
  if (typeof payload[slotKey] === "string") return payload;

  const date = payload[dateKey];
  if (typeof date !== "string" || !ISO_DATE_RE.test(date)) return payload;
  const partySize = await resolveSlotPartySize(kind, payload, customerId);
  if (partySize === undefined) return payload;
  const time = typeof payload[timeKey] === "string" ? payload[timeKey] : undefined;

  let slots;
  try {
    slots = await createReservationService().checkAvailability(date, partySize, time);
  } catch {
    return payload; // fail-safe → honest refuse downstream
  }
  if (slots.length === 1) {
    return { ...payload, [slotKey]: slots[0]!.timeSlotId };
  }
  if (slots.length >= 2) {
    // BKL-174 — carry the first-party candidate TIMES (the availability read's own
    // `startTime`s, never model-authored) alongside the count so the pack-side
    // CLARIFY guard can NAME the options ("qual horário: 18h30, 20h…?") instead of a
    // bare slot-missing refuse. The slot key stays UNSTAMPED → the slot guard still
    // fails closed.
    return {
      ...payload,
      slotAmbiguousCount: slots.length,
      slotAmbiguousTimes: slots.map((s) => s.startTime),
    };
  }
  return payload; // 0 slots → honest no-availability refuse (slot unstamped)
}

/**
 * 034-F1 (finding 6/7): bind refund ownership through the payment's order. The
 * refund target stays the explicit paymentId; this only supplies the orderId the
 * ownership graph needs (NOT an autoresolve → no forced confirm).
 */
async function bindRefundOwnership(kind: string, payload: Ctx): Promise<Ctx> {
  if (
    REFUND_OWNERSHIP_KINDS.has(kind) &&
    typeof payload.orderId !== "string" &&
    typeof payload.paymentId === "string"
  ) {
    const oid = await resolvePaymentOrderId(payload.paymentId);
    if (oid !== null) return { ...payload, orderId: oid };
  }
  return payload;
}

/**
 * BKL-094 coercion class (team-lead ruling — distinct from the `reason`/
 * `payment_method`-vs-`payment` KEY-drift question, which stays UNMAPPED
 * per that ruling): live calibration showed the 4B reliably uses the RIGHT
 * wire KEY but sometimes a Portuguese/English SYNONYM instead of the closed
 * enum value itself ("cartão", "crédito", "débito", "credit", "debit",
 * "dinheiro" for payment_method; "retirada"/"buscar" for delivery_type).
 * Deterministic, CLOSED synonym maps — never a fuzzy/heuristic match — so an
 * UNRECOGNIZED value passes through UNCHANGED to `validatePaymentMethod`'s
 * existing "not in VALID_PAYMENT_METHODS" REFUSE path exactly as before
 * these maps existed (never mapped to null, never silently dropped).
 *
 * WHY this doesn't break "the sidecar stays honest": there is only ONE
 * payload flowing through this whole pipeline into BOTH the adjudicated
 * envelope AND `audit-metadata.ts`'s post-hoc sidecar derivation — no
 * separate "raw wire" channel survives past this seam (by design; see the
 * ADR-124 v5 sidecar's own doc). Normalizing the VALUE here, before
 * anything else ever reads it, means `extractionIR.payload.payment_method`
 * correctly shows the POST-NORMALIZATION value ("card") the guards actually
 * acted on — "honest" means the sidecar's `provenance` stays
 * `{producer:"model", trust:"untrusted"}` (never silently promoted to
 * resolver/authoritative just because it passed through a synonym map), not
 * that the pre-normalization string survives somewhere for the corpus to
 * assert against. The corpus therefore asserts POST-normalization values.
 */
const PAYMENT_METHOD_VALUE_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["pix", "pix"],
  ["card", "card"],
  ["cartão", "card"],
  ["cartao", "card"],
  ["crédito", "card"],
  ["credito", "card"],
  ["débito", "card"],
  ["debito", "card"],
  ["credit", "card"],
  ["debit", "card"],
  ["cash", "cash"],
  ["dinheiro", "cash"],
]);

const DELIVERY_TYPE_VALUE_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["pickup", "pickup"],
  ["retirada", "pickup"],
  ["buscar", "pickup"],
  ["delivery", "delivery"],
  ["entrega", "delivery"],
]);

/** Case/whitespace-insensitive closed-map lookup; an unrecognized value passes through UNCHANGED (never null, never dropped) — see the synonym maps' own doc for why. */
function normalizeSynonymValue(value: string, synonyms: ReadonlyMap<string, string>): string {
  return synonyms.get(value.trim().toLowerCase()) ?? value;
}

/**
 * FE-T12 (team-lead review) — rename `order.checkout.create`'s WIRE field
 * `payment_method` (snake_case, `order-checkout-create.schema.ts`'s model-
 * facing extraction schema) to the internal `paymentMethod` key
 * `OrderCheckoutCreatePayload`/`validatePaymentMethod` (pack-orders/src/
 * policies.ts, BYTE-UNTOUCHED) actually reads, THEN normalizes the VALUE
 * through `PAYMENT_METHOD_VALUE_SYNONYMS` (see that map's own doc for the
 * key-vs-value distinction and why this doesn't compromise sidecar honesty).
 *
 * WHY snake_case on the wire: live 4B calibration showed a 100%-stable bias
 * toward `payment_method` over the originally-authored `paymentMethod` on
 * EVERY observed call — a fact to accommodate deterministically (rename the
 * wire contract to match what the model reliably produces) rather than fight
 * with more prompt text. Mirrors the established BKL-094/BKL-089 rename
 * idiom (payment.refund.issue's `orderReference`→`orderId`, `amount`→
 * `refundAmountCentavos`): the WIRE name is consumed and REPLACED here, never
 * left duplicated alongside the internal one — a stray `payment_method` key
 * surviving into the resolved payload would leak past this seam into the
 * envelope pack-orders never reads, dead weight at best.
 *
 * Pure rename+normalize, unconditional on any other resolution step (no
 * auto-resolve, no ownership binding) — called first, before
 * `applyAutoResolve`.
 */
function mapCheckoutPaymentMethodWireField(kind: string, payload: Ctx): Ctx {
  if (kind !== "order.checkout.create") return payload;
  if (typeof payload.payment_method !== "string") return payload;
  // Defensive: a caller that already set the internal key (never happens on
  // the real model-facing path — the extraction schema simply never declares
  // `paymentMethod` as a field; only `payment_method` is ever shown to the
  // model) never gets silently overwritten by the wire alias.
  if (typeof payload.paymentMethod === "string") return payload;
  const { payment_method: wireValue, ...rest } = payload;
  return {
    ...rest,
    paymentMethod: normalizeSynonymValue(wireValue, PAYMENT_METHOD_VALUE_SYNONYMS),
  };
}

/**
 * FE-T12 (team-lead ruling, cart-seeding investigation follow-up) — same
 * wire-rename idiom as `mapCheckoutPaymentMethodWireField` (KEY rename +
 * VALUE normalization via `DELIVERY_TYPE_VALUE_SYNONYMS`), for the SECOND
 * checkout wire field: `delivery_type` (snake_case, same live-calibration
 * bias-accommodation logic) -> the internal `deliveryType` key
 * `buildCartCtx` reads (`payload.deliveryType ?? payload.fulfillment` ->
 * `ctx.fulfillment`).
 *
 * WHY this field exists at all: `requireSlotsFilledForCheckout`
 * (pack-orders/src/policies.ts, a STATE guard that runs BEFORE
 * `validatePaymentMethod`/the money-band guards) REFUSEs
 * `order.checkout.slots_incomplete` whenever `ctx.fulfillment` is null — and
 * `ctx.fulfillment` was ONLY ever populated from `payload.deliveryType`/
 * `payload.fulfillment`, a slot the HTTP cart route threads explicitly but
 * the chat planner never had a schema field for. Chat checkout therefore
 * structurally could never pass this guard, regardless of payment_method or
 * cart contents — a real gap live-caught during this ticket's own
 * cart-seeding investigation, not a pre-existing one this ticket
 * introduced. This wire field closes it: the model may now supply
 * pickup/delivery in the same turn as payment_method, and BOTH slots being
 * spoken lets a chat checkout progress all the way to the money-band
 * guards — no new confirm path, no guard changes, the same ladder the HTTP
 * route always had.
 */
function mapCheckoutDeliveryTypeWireField(kind: string, payload: Ctx): Ctx {
  if (kind !== "order.checkout.create") return payload;
  if (typeof payload.delivery_type !== "string") return payload;
  if (typeof payload.deliveryType === "string") return payload;
  const { delivery_type: wireValue, ...rest } = payload;
  return {
    ...rest,
    deliveryType: normalizeSynonymValue(wireValue, DELIVERY_TYPE_VALUE_SYNONYMS),
  };
}

/**
 * team-lead ruling (FE-T14 live-calibration, the T12 payment_method lesson
 * applied) — same wire-rename idiom as `mapCheckoutPaymentMethodWireField`
 * (KEY rename only, no value normalization needed — these are freeform
 * string arrays, not a closed synonym set), for `customer.preferences.
 * update`'s two wire fields: `dietary_restrictions`/`favorite_categories`
 * (snake_case, matching live-observed model emission — see customer-
 * whatsapp-convenience.schema.ts's own doc) -> the STABLE internal
 * `dietaryFlags`/`favoriteCategories` keys every other consumer (pack-
 * customer-onboarding/src/types.ts, routes/me.ts, admin-customer-
 * compose.ts) already reads. Pure rename, unconditional, called first
 * alongside the checkout renames — before `applyAutoResolve`.
 */
function mapPreferencesUpdateWireFields(kind: string, payload: Ctx): Ctx {
  if (kind !== "customer.preferences.update") return payload;
  let out = payload;
  if (Array.isArray(out.dietary_restrictions) && typeof out.dietaryFlags === "undefined") {
    const { dietary_restrictions: wireValue, ...rest } = out;
    out = { ...rest, dietaryFlags: wireValue };
  }
  if (Array.isArray(out.favorite_categories) && typeof out.favoriteCategories === "undefined") {
    const { favorite_categories: wireValue, ...rest } = out;
    out = { ...rest, favoriteCategories: wireValue };
  }
  return out;
}

/**
 * F3/L1 (D-014) — thread resolved ids from ctx back onto the outgoing payload.
 *
 * The Conductor hands the executor tool `envelope.payload`, but the session
 * cartId is resolved into ctx (not the payload), so a cart mutation EXECUTEs and
 * then the tool throws a ZodError on the missing `cartId` — the customer can
 * never add an item / apply a coupon / check out by message. Copy the resolved
 * ids from ctx onto the payload for the kinds whose executor schema requires
 * them, WITHOUT overriding an explicitly-supplied value.
 *
 * `ctx.cartId` is a string ONLY for the cart-op order.* kinds (they route
 * through loadCartCtx); order-by-id kinds (cancel/amend) get `cartId: null` from
 * loadOrderCtx, so this is self-scoping — it only fires when a cart was resolved.
 * reservation.* executors require `customerId` (identity, never LLM-supplied).
 */
/** First non-empty trimmed string among the candidates, else undefined. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Lowercase, strip diacritics, split into alnum tokens — for lexical
 *  comparison only (never customer-facing, never persisted). */
function normalizeTokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * FE-D17 interim defense (FE-T09b, BKL-154 live-drive follow-up) — a cheap
 * lexical-overlap sanity floor over the search layer's ranking. Typesense's
 * fuzzy/semantic ranking can return a best-effort top hit with NO real
 * relationship to the query on a garbage input (live-demonstrated: query
 * "xyzzy" still returned A product) — the systemic arbitrary-match defect
 * is FE-D17 (search-layer fix, not this ticket's scope); this is the
 * resolver-level floor that refuses to attach an UNRELATED product's
 * variant/allergens to the customer's request in the meantime. Permissive
 * by TOKEN/CONTAINMENT overlap (any shared normalized token, or either
 * string containing the other) — but this is NOT the same as "never
 * rejects a genuine partial match": a pt-BR DIMINUTIVE ("coquinha" for
 * "coca") shares no token and no substring with "Coca-Cola" and is treated
 * as a mismatch (REFUSED) exactly like "xyzzy" today. That is an ACCEPTED
 * INTERIM COST, not an oversight — a real fuzzy/stemmed match belongs in
 * the search layer itself (FE-D17), not reimplemented here; this floor's
 * job is only to stop an UNRELATED top hit from being trusted blindly. See
 * the "coquinha" regression in resolve-and-assemble.test.ts, which pins
 * today's refuse behavior deliberately so a future change to this
 * function is a conscious choice, not an accidental regression either way.
 */
function hasLexicalOverlap(query: string, product: { title?: string; tags?: readonly string[] }): boolean {
  const queryTokens = normalizeTokens(query);
  if (queryTokens.length === 0) return false;
  const queryTokenSet = new Set(queryTokens);
  const candidateTokens = new Set([
    ...normalizeTokens(product.title ?? ""),
    ...(product.tags ?? []).flatMap(normalizeTokens),
  ]);
  for (const t of queryTokenSet) {
    if (candidateTokens.has(t)) return true;
  }
  const queryNorm = queryTokens.join(" ");
  const titleNorm = normalizeTokens(product.title ?? "").join(" ");
  if (titleNorm.length === 0) return false;
  return titleNorm.includes(queryNorm) || queryNorm.includes(titleNorm);
}

/**
 * F3/L1 (BKL-061) — deterministic NL→variantId resolution (a READ; keeps this
 * module's read-only invariant). The 4B emits order.item.add with a LOOSE
 * product name (e.g. `{item:"coca cola"}`) — no variantId. Resolve it via
 * Typesense (`searchProducts`) so the executor's schema (which requires
 * variantId) is satisfiable. Returns undefined on no-match/error → the tool
 * REFUSEs honestly ("não encontrei esse item") rather than adding the wrong one.
 *
 * FE-T09b (FE-D17 interim floor) — a non-empty result is no longer trusted
 * blindly: `hasLexicalOverlap` must agree the top hit actually relates to
 * `name` before its variantId/allergens are attached. A hit with zero
 * lexical relationship to the query is treated exactly like no match at
 * all (same undefined return, same downstream honest refuse) — this
 * function's return contract is unchanged, only which hits qualify.
 */
async function resolveProductForItem(
  name: string,
  channel: string,
  sessionId: string | undefined,
  customerId: string,
): Promise<{ variantId?: string; allergens?: string[] } | undefined> {
  try {
    const out = await searchProducts(
      { query: name },
      {
        channel: channel === "whatsapp" ? Channel.WhatsApp : Channel.Web,
        sessionId: sessionId ?? customerId,
        ...(isGuestCustomerId(customerId) ? {} : { userId: customerId }),
        userType: "customer",
      },
    );
    const product = out.products?.[0];
    if (product === undefined) return undefined;
    if (!hasLexicalOverlap(name, product)) return undefined;
    // allergens = the product's EXPLICIT stored array (Hard Rule #1: authoritative
    // product data, NOT inferred from name/text). Same resolved product as the
    // variant, so they can never disagree.
    return {
      variantId: product.variants?.[0]?.id,
      ...(Array.isArray(product.allergens) ? { allergens: product.allergens } : {}),
    };
  } catch {
    return undefined;
  }
}

// ── BKL-213 — multi-ITEM decomposition for a compound cart add ──────────────
// The 4B routinely under-decomposes "duas Farofas E tres Refrigerantes" into a
// SINGLE order.item.add (Farofa only), dropping the trailing item entirely —
// distinct from BKL-199 (quantity, already fixed): here whole ITEMS vanish, so
// a customer asking for two products gets one. Same discipline as NL→variantId
// and NL→quantity: never trust the model to enumerate — recover the dropped
// items DETERMINISTICALLY from the customer's own words. The caller (the
// resolver) emits one more order.item.add per recovered item, each independently
// re-run through `resolveAndAssemble` (allergen strip/refill, quantity derive,
// ownership) and adjudicated, so no guard is bypassed. Cart-scoped and reversible
// (pre-checkout); a mis-recovery adds a cart line the customer can remove.

/** pt-BR item-list conjunction separators: " e ", ",", " mais " (word-bounded so
 *  "mais" as a size adjective inside a name is not a false split; substring "e"
 *  inside a word never matches). */
const ITEM_CONJUNCTION_RE = /\s+e\s+|\s*,\s*|\s+mais\s+/i;

/** A recovered fragment must carry a content word (≥3 chars, not a pure
 *  quantity/stopword) or it can't name a product. */
function fragmentHasContentWord(fragment: string): boolean {
  for (const tok of normalizeTokens(fragment)) {
    if (tok.length >= 3 && !ITEM_REF_STOPWORDS.has(tok) && quantityFromToken(tok) === undefined) {
      return true;
    }
  }
  return false;
}

/** Max ADDITIONAL cart items recovered from one compound add (5-line chat order
 *  is already implausible; bounds a pathological utterance). */
const MAX_ADDITIONAL_CART_ITEMS = 4;

/**
 * BKL-213 — recover the ADDITIONAL cart-item names a compound "X e Y" add
 * dropped. Split the full utterance on pt-BR list conjunctions, resolve each
 * fragment against the catalog, and return the fragment names that resolve to a
 * DISTINCT product — different variantId from the primary (already added) AND
 * from each other. Returns `[]` (the safe default) for a single-item utterance,
 * a one-dish name ("arroz e feijão" resolving to ONE combo → its fragments both
 * hit the same variant → deduped away), or when nothing distinct resolves. The
 * caller re-runs `resolveAndAssemble` on each returned name for identical
 * treatment. Pure of side effects beyond the catalog reads.
 */
export async function deriveAdditionalCartItemNames(args: {
  readonly utteranceText: string | undefined;
  readonly primaryVariantId: string | undefined;
  readonly channel: string;
  readonly sessionId: string | undefined;
  readonly customerId: string;
}): Promise<string[]> {
  const { utteranceText, primaryVariantId, channel, sessionId, customerId } = args;
  if (typeof utteranceText !== "string" || utteranceText.trim() === "") return [];
  const fragments = utteranceText
    .split(ITEM_CONJUNCTION_RE)
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && fragmentHasContentWord(f));
  // A single fragment ⇒ no conjunction ⇒ nothing to recover (the common case).
  if (fragments.length < 2) return [];

  const names: string[] = [];
  const seenVariants = new Set<string>();
  // The primary product is already in the cart via the model's own add — never
  // re-add it (the "quero duas farofas" fragment resolves to the primary variant
  // and is dropped here).
  if (typeof primaryVariantId === "string") seenVariants.add(primaryVariantId);

  for (const fragment of fragments) {
    if (names.length >= MAX_ADDITIONAL_CART_ITEMS) break;
    const resolved = await resolveProductForItem(fragment, channel, sessionId, customerId);
    const variantId = resolved?.variantId;
    // Only a fragment that resolves to a DISTINCT product becomes an extra add —
    // this is the "don't split inside an item name / one dish" guard: a
    // non-resolving fragment, or one that hits an already-covered variant, is
    // skipped, so over-splitting can never invent a spurious line.
    if (typeof variantId !== "string" || seenVariants.has(variantId)) continue;
    seenVariants.add(variantId);
    names.push(fragment);
  }
  return names;
}

/** The three-way outcome of resolving an NL item reference against a live
 *  order's line items — see `resolveOrderLineItem`. */
type OrderLineItemResolution =
  | { readonly kind: "found"; readonly itemId: string }
  | { readonly kind: "ambiguous"; readonly count: number }
  | { readonly kind: "not_found" };

/** A live order/cart line's minimal identifying shape both resolvers below
 *  match against — see `resolveLineItemByNameOrVariant`. */
interface ResolvableLineItem {
  readonly id: string;
  readonly title?: string;
  readonly variant_id?: string;
}

/**
 * team-lead ruling (FE-T14 live-calibration finding, the variantId bridge) —
 * the shared NL→line-item matching core BOTH `resolveOrderLineItem` and
 * `resolveCartLineItem` thread through, so the two can never drift (FE-D07:
 * duplicated matching logic is exactly the hazard class that ruling warned
 * against).
 *
 * LIVE-CAUGHT DEFECT this closes: the original exact-title-only match
 * compared the model's casual NL reference ("coca", "guaraná") against each
 * line's `.title`, which Medusa always sets to the PRODUCT title
 * ("Refrigerante") — NEVER the variant title ("Coca-Cola") or a customer's
 * casual single-word reference. Every case in this rollout's item.update/
 * item.remove/amend.update_qty/amend.remove_item corpora that named a
 * specific variant this way therefore resolved `not_found` against the REAL
 * catalog regardless of seeding — a structural gap, not a seeding problem
 * (first live calibration for this whole capability family; see the PR
 * body's live-calibration section for the full finding).
 *
 * FIX — two arms, tried in order:
 *   1. Exact-title match FIRST (fast path, no network round-trip): if it
 *      resolves to EXACTLY one line, done — covers a customer naming the
 *      literal product title directly ("remove o Refrigerante" with only
 *      one refrigerante line in the cart).
 *   2. The variantId bridge: `resolveProductForItem` (the SAME Typesense +
 *      lexical-overlap-floor search `order.item.add`/`order.amend.add_item`
 *      already use) resolves the NL reference to a real catalog variantId
 *      ("coca" -> the Coca-Cola variant), then lines are matched by
 *      `variant_id` — this is what actually disambiguates two same-titled
 *      "Refrigerante" lines by which SPECIFIC variant the customer named,
 *      the exact scenario exact-title-only can never resolve. Only runs
 *      when arm 1 didn't cleanly resolve (0 or >1 exact-title matches) —
 *      cheap literal references never pay the round-trip cost.
 *
 * The found/ambiguous/not_found contract is preserved EXACTLY: this
 * BROADENS which references resolve to `found` (a prior `not_found` can now
 * resolve) but never narrows an existing `found`/`ambiguous` outcome — the
 * bridge only ever RUNS when arm 1 didn't already conclusively resolve, and
 * arm 1's own tie (`ambiguous`) is preserved as the fallback result if the
 * bridge doesn't resolve it to exactly one line either. `hasLexicalOverlap`'s
 * existing arbitrary-match floor (inside `resolveProductForItem`) still
 * guards this path — an unrelated top hit still yields `undefined`, which
 * this function treats as "the bridge didn't help," never a guess.
 */
async function resolveLineItemByNameOrVariant(
  items: readonly ResolvableLineItem[],
  name: string,
  channel: string,
  sessionId: string | undefined,
  customerId: string,
): Promise<OrderLineItemResolution> {
  const needle = name.trim().toLowerCase();
  const exactMatches = items.filter((i) => (i.title ?? "").toLowerCase() === needle);
  if (exactMatches.length === 1) return { kind: "found", itemId: exactMatches[0]!.id };

  const resolved = await resolveProductForItem(name, channel, sessionId, customerId);
  if (resolved?.variantId !== undefined) {
    const variantMatches = items.filter((i) => i.variant_id === resolved.variantId);
    if (variantMatches.length === 1) {
      return { kind: "found", itemId: variantMatches[0]!.id };
    }
    if (variantMatches.length > 1) {
      return { kind: "ambiguous", count: variantMatches.length };
    }
  }

  if (exactMatches.length > 1) return { kind: "ambiguous", count: exactMatches.length };
  return { kind: "not_found" };
}

/**
 * FE-T09 (D-a) — NL→itemId resolution for the granular post-checkout amend
 * kinds `order.amend.update_qty` / `order.amend.remove_item`. These operate
 * on a line ALREADY on a placed order, not the catalog — a LIVE order fetch
 * (mirroring the legacy `amend-order.ts` tool's `svc.getOrder`), matched via
 * `resolveLineItemByNameOrVariant` (see that function's header for the full
 * exact-title + variantId-bridge design). The stored `OrderProjection.
 * itemsJson` carries no stable per-line id (`medusa-order.mapper.ts` drops
 * Medusa's own line-item id when building the projection); a data-model
 * migration to persist one is tracked separately (FE-D15) — the live fetch
 * sidesteps it, exactly as the legacy tool does. `MedusaOrder.items[]`
 * already carries `variant_id` per line (order.service.ts), so no extra
 * fetch is needed for the bridge's variant-matching arm.
 *
 * Two safety upgrades over the legacy tool's exact-first-match, both
 * PRESERVED by the shared core: zero matches → `"not_found"` (an honest
 * refuse downstream — never a guess); MULTIPLE matches (e.g. two "coca"
 * lines) → `"ambiguous"` (carries the match `count`) — review finding
 * (post-#264): the FIRST cut of this reused `ctx.autoResolvedMoneyRef` /
 * `confirmOnAutoResolveGuard` (the ORDER-level "which order?" auto-resolve's
 * confirm mechanism) here too, but that mechanism means "I GUESSED a value,
 * please confirm the guess" — item-level ambiguity picks NO item at all, so
 * routing it through a yes/no confirm falsely implies a specific item was
 * identified, and confirming resumed into a resolver call with
 * `itemId: undefined` — a dead end ("Item não encontrado" after the
 * customer just said "yes"). Fixed: `threadResolvedIdsIntoPayload` leaves
 * `itemId` unset AND does NOT touch `ctx.autoResolvedMoneyRef` for this
 * case; it instead stamps `itemAmbiguousCount` onto the payload so the
 * EXECUTOR (`register-ibatexas-tool-packs.ts`) can return an honest,
 * specific disambiguation reply immediately — reusing the SAME "tool
 * reports a business-level non-match" idiom the `"not_found"` case already
 * used (no new kernel Decision, no confirm, no park).
 *
 * On a match, `itemId` is the matched line's REAL Medusa line-item id (the
 * same id the legacy tool's own Medusa PATCH/edit calls use) — the executor
 * (`register-ibatexas-tool-packs.ts`) does one cheap reverse (id→title)
 * lookup against the same live order before delegating to the existing,
 * tested `amendOrder()` (which is title-keyed), rather than re-implementing
 * Medusa's order-edit mutation calls.
 */
async function resolveOrderLineItem(
  orderId: string,
  name: string,
  customerId: string,
  channel: string,
  sessionId: string | undefined,
): Promise<OrderLineItemResolution> {
  try {
    const { order, ownershipValid } = await createOrderService(medusaAdmin).getOrder(
      orderId,
      customerId,
    );
    if (!ownershipValid) return { kind: "not_found" };
    return await resolveLineItemByNameOrVariant(
      order.items ?? [],
      name,
      channel,
      sessionId,
      customerId,
    );
  } catch {
    return { kind: "not_found" };
  }
}

/**
 * FE-T14 — NL→cart-line-itemId resolution for `order.item.update` /
 * `order.item.remove`. These operate on the ACTIVE SESSION CART (unlike
 * `resolveOrderLineItem`'s placed-order target), so this is a genuinely
 * separate lookup — never a catalog-wide guess (`resolveProductForItem`,
 * used by `order.item.add`, resolves a NEW catalog product; this resolves
 * an EXISTING cart LINE) — but matched via the SAME
 * `resolveLineItemByNameOrVariant` core as `resolveOrderLineItem`, kept
 * mirrored deliberately (FE-D07) rather than re-implementing the exact-
 * title + variantId-bridge logic a second time.
 *
 * `medusaStore`'s raw `/store/carts/:id` response line items carry `id`
 * (the real Medusa line-item id `update_cart`/`remove_from_cart`'s wire
 * schema requires), `title` (defaults to the PRODUCT title at add time —
 * never the variant title, the exact defect the shared core's bridge
 * closes), and `variant_id` (the real Medusa variant id the bridge matches
 * against) — a WIDER local shape than `MedusaCartLine` above, which only
 * projects the fields `buildCartCtx` needs for guard purposes.
 */
interface MedusaCartLineWithTitle {
  readonly id: string;
  readonly title?: string;
  readonly variant_id?: string;
}

async function resolveCartLineItem(
  cartId: string,
  name: string,
  channel: string,
  sessionId: string | undefined,
  customerId: string,
): Promise<OrderLineItemResolution> {
  try {
    const data = (await medusaStore(`/store/carts/${cartId}`)) as {
      cart?: { items?: ReadonlyArray<MedusaCartLineWithTitle> };
    };
    return await resolveLineItemByNameOrVariant(
      data.cart?.items ?? [],
      name,
      channel,
      sessionId,
      customerId,
    );
  } catch {
    return { kind: "not_found" };
  }
}

/** FE-D28 — the three-way outcome of resolving the reviewed product from an
 *  order's OWN line items (a review is purchase-bound). Mirrors
 *  `OrderLineItemResolution`'s found/ambiguous/not_found contract, but returns
 *  the catalog `productId` (what a review attaches to) rather than a line id. */
type ReviewedProductResolution =
  | { readonly kind: "found"; readonly productId: string }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not_found" };

/**
 * FE-D28 — resolve `order.review.submit`'s (Identity-class, forbidden)
 * productId from the reviewed order's OWN line items. `getById` is owner-scoped
 * (SDD §N P0-3), so a non-owner / unattributed order yields no items and
 * nothing resolves — a customer can only review a product they bought.
 *
 *   - Exactly ONE distinct product on the order → resolves unambiguously (no
 *     `item` reference needed: "dou 5 estrelas pro pedido").
 *   - A multi-product order is disambiguated by the model's NL `item` reference
 *     ("a costela"), matched lexically against the lines' titles (the same
 *     both-ways substring test `hasLexicalOverlap` uses). A single distinct
 *     product match resolves; multiple → ambiguous; none → not_found.
 *
 * NEVER guesses: an ambiguous/no-match reference resolves to nothing and the
 * caller stamps a ctx marker so the kernel REFUSEs/clarifies honestly (the same
 * posture the granular-amend itemId not-found/ambiguous path takes). Fail-safe
 * to `not_found` on any read error.
 */
async function resolveReviewedProduct(
  orderId: string,
  itemName: string | undefined,
  customerId: string,
): Promise<ReviewedProductResolution> {
  try {
    const order = await createOrderQueryService().getById(orderId, { customerId });
    // itemsJson is a Prisma JsonArray on the projection (denormalized line
    // items, OrderEventItem shape) — cast through unknown per the me.ts review
    // route's own `itemsJson` access idiom.
    const items = (
      Array.isArray(order?.itemsJson) ? order.itemsJson : []
    ) as unknown as OrderEventItem[];
    const distinctProductIds = [
      ...new Set(
        items
          .map((it) => it?.productId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    if (distinctProductIds.length === 0) return { kind: "not_found" };
    if (distinctProductIds.length === 1) {
      return { kind: "found", productId: distinctProductIds[0]! };
    }

    // Multi-product order: an explicit item reference is required to disambiguate.
    const needleNorm = normalizeTokens(itemName ?? "").join(" ");
    if (needleNorm.length === 0) return { kind: "ambiguous" };
    const matchedProductIds = [
      ...new Set(
        items
          .filter((it) => {
            const titleNorm = normalizeTokens(it?.title ?? "").join(" ");
            return (
              titleNorm.length > 0 &&
              (titleNorm.includes(needleNorm) || needleNorm.includes(titleNorm))
            );
          })
          .map((it) => it?.productId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    if (matchedProductIds.length === 1) return { kind: "found", productId: matchedProductIds[0]! };
    if (matchedProductIds.length > 1) return { kind: "ambiguous" };
    return { kind: "not_found" };
  } catch {
    return { kind: "not_found" };
  }
}

async function threadResolvedIdsIntoPayload(
  kind: string,
  payload: Ctx,
  ctx: Ctx,
  customerId: string,
  channel: string,
  sessionId: string | undefined,
  utteranceText: string | undefined,
): Promise<Ctx> {
  let out = payload;
  if (
    kind.startsWith("order.") &&
    typeof ctx.cartId === "string" &&
    typeof out.cartId !== "string"
  ) {
    out = { ...out, cartId: ctx.cartId };
  }
  if (
    kind.startsWith("reservation.") &&
    typeof out.customerId !== "string" &&
    customerId
  ) {
    out = { ...out, customerId };
  }
  // BKL-103 — the `order.cancel` PROPOSER stamp (Identity class, resolver-owned).
  //
  // `order.cancel` is a RESUMABLE escalation kind: a >=R$1.000 PAID cancel
  // ESCALATEs, parks, and an OWNER may approve it, at which point
  // `gatePaidCancel`'s overlay (`@ibatexas/pack-orders`) compares
  // `approval.approverId !== payload.actorId`. That comparand only exists if the
  // AUTHENTICATED write side stamps it — the HTTP plane does so in
  // routes/order-actions.ts, and this is the conversational plane's equivalent.
  // Without it the overlay refuses to convert (it requires a non-empty proposer),
  // so an approved big-ticket cancel could never resume.
  //
  // Always OVERWRITTEN from the Capsule's authenticated `customerId`, never
  // conditional on what arrived: `actorId` is in `FORBIDDEN_EXTRACTION_FIELD_NAMES`
  // so no extraction schema can offer it to the model, and an unconditional
  // overwrite means even a smuggled value cannot survive (the `allergens`
  // provenance lesson above — a "fill only if absent" test is exactly what a
  // well-formed adversarial completion defeats). A forged proposer would not grant
  // a bypass (it makes the inequality trivially TRUE, i.e. it would let a
  // self-approving owner convert), which is precisely why provenance is forced here.
  //
  // It doubles as the customer scope the resume re-projection reads
  // (`escalationResumeSeedState`), because the conversational envelope's
  // `actor.sessionId` is a CONVERSATION id, not a customer id.
  if (kind === "order.cancel" && customerId) {
    out = { ...out, actorId: customerId };
  }
  // BKL-061 + BKL-067 + FE-T09: order.item.add (cart) / order.amend.add_item
  // (a placed order) — resolve a loose product name to the product (READ)
  // and inject variantId + the product's EXPLICIT allergens (pack-orders
  // requireExplicitAllergens; Hard Rule #1) + default quantity, so the
  // executor schema AND the allergen guard are satisfiable from the 4B's
  // loose emission. cartId comes from BKL-028 (session cart) which BKL-066
  // ensures exists; order.amend.add_item instead carries orderId (already
  // resolved above by applyAutoResolve's ORDER_AUTORESOLVE_KINDS handling —
  // the model is never shown orderId, per order-amend-granular.schema.ts).
  //
  // Review finding (post-#264, MAJOR): `allergens` used to fill only when
  // `!Array.isArray(out.allergens)` — a well-formed-but-adversarial
  // completion smuggling `allergens: []` (or any array) past the extraction
  // schema was treated as "already resolved" and SURVIVED untouched, and
  // `requireExplicitAllergens` (pack-orders) only checks the SHAPE (is it
  // an array?), never the provenance — so a smuggled array defeated the
  // authoritative fill entirely (Hard Rule #1 / AC3: allergens must be
  // impossible for the model to populate). Fixed: `allergens` is now
  // UNCONDITIONALLY stripped from whatever the payload carries and refilled
  // ONLY from the resolved product — a resolution miss leaves it absent
  // (never falls back to the stripped value), so `requireExplicitAllergens`
  // correctly REFUSEs rather than trusting an unverified array. `variantId`
  // keeps its original conditional-preserve behavior (an explicit, non-NL
  // variantId is a legitimate non-model input elsewhere — see "does not
  // override an explicit variantId"); only `allergens` is in this review's
  // "same one-line class" scope.
  if (kind === "order.item.add" || kind === "order.amend.add_item") {
    const needsVariant = typeof out.variantId !== "string";
    const { allergens: _modelSuppliedAllergens, ...strippedOfAllergens } = out;
    out = strippedOfAllergens;
    const name = firstString(out.item, out.product, out.productName, out.name, out.query);
    if (name) {
      const resolved = await resolveProductForItem(name, channel, sessionId, customerId);
      if (resolved !== undefined) {
        if (needsVariant && resolved.variantId !== undefined) {
          out = { ...out, variantId: resolved.variantId };
        }
        if (Array.isArray(resolved.allergens)) {
          out = { ...out, allergens: resolved.allergens };
        }
      }
    }
    // Review B3 + BKL-199: the 4B emits quantity as a STRING ("2") OR — the
    // common live failure — DROPS the stated number entirely ("dois
    // Refrigerantes"/"40 Brisket" → quantity absent → 1), silently
    // under-delivering and making the ≥R$1k confirm band unreachable.
    // `deriveItemQuantity` recovers the customer's stated count deterministically
    // from their own words (the NL→variantId discipline for the integer), with
    // coerceQuantity's string-coerce/default-1 as the fall-through. A present
    // but invalid value with no parseable NL quantity is still left untouched so
    // AddToCartInputSchema refuses loudly — never a silently different quantity.
    out = { ...out, quantity: deriveItemQuantity(out.quantity, name, utteranceText) };
    // FE-D18 — no-match honesty floor for the amend path. The cart sibling
    // order.item.add already REFUSEs honestly on an unresolvable item (it is
    // NOT in AUTORESOLVE_CONFIRM_KINDS → immediate adjudication → the
    // allergens-absent requireExplicitAllergens REFUSE). order.amend.add_item
    // IS in that set, so confirmOnAutoResolveGuard would otherwise park a
    // doomed envelope — no variantId, no allergens — behind a found-implying
    // "Confirma?" prompt, and the kernel only REFUSEs it on resume. Stamp the
    // ctx flag `refuseUnresolvedAmendItemGuard` (compose-policy-packs.ts) reads
    // to REFUSE pre-park with an honest "não encontrei esse item" reply.
    // Fires ONLY on this stamped-flag path: variantId still absent after
    // hydration (name absent, no catalog match, or the lexical-overlap floor
    // refused an arbitrary Typesense hit). An explicit non-model variantId
    // (needsVariant was false) — including the resolved variantId the resume
    // leg carries — leaves variantId present, so the flag is never stamped and
    // the resume re-adjudicates normally.
    if (kind === "order.amend.add_item" && typeof out.variantId !== "string") {
      ctx.amendItemUnresolved = true;
    }
  }
  // FE-T09 (D-a) — order.amend.update_qty / order.amend.remove_item: resolve
  // the model's NL `item` reference against the LIVE order's line items
  // (never a catalog-wide guess) via `resolveOrderLineItem`, mirroring
  // amend-order.ts's existing title-match semantics with two safety
  // upgrades over the legacy exact-first-match: zero matches leave itemId
  // unresolved so the executor reports an honest not-found (never executing
  // against a guessed line); MULTIPLE matches stamp `itemAmbiguousCount` on
  // the payload (never `ctx.autoResolvedMoneyRef` — see the docblock on
  // `resolveOrderLineItem` for why that would be dishonest here) so the
  // executor can surface a specific disambiguation reply instead of
  // guessing between e.g. two "coca" lines. Requires orderId to already be
  // present (resolved above).
  if (
    (kind === "order.amend.update_qty" || kind === "order.amend.remove_item") &&
    typeof out.itemId !== "string" &&
    typeof out.orderId === "string"
  ) {
    const orderId = out.orderId;
    // Always decided fresh below (found/ambiguous/not_found) — never
    // preserved from a pre-existing value, so there is nothing here for an
    // adversarial completion to smuggle in and have survive unexamined.
    const { itemAmbiguousCount: _staleAmbiguousCount, ...strippedOfAmbiguity } = out;
    out = strippedOfAmbiguity;
    const name = firstString(out.item, out.product, out.name, out.query);
    if (name) {
      const resolution = await resolveOrderLineItem(orderId, name, customerId, channel, sessionId);
      if (resolution.kind === "found") {
        out = { ...out, itemId: resolution.itemId };
      } else if (resolution.kind === "ambiguous") {
        out = { ...out, itemAmbiguousCount: resolution.count };
      }
      // resolution.kind === "not_found": itemId stays unresolved — the
      // executor reports an honest not-found rather than guessing.
    }
    if (kind === "order.amend.update_qty") {
      out = { ...out, quantity: coerceQuantity(out.quantity) };
    }
  }
  // FE-T14 — order.item.update / order.item.remove: same NL→itemId shape as
  // the granular amend block above, but resolved against the ACTIVE CART
  // (resolveCartLineItem) rather than a placed order — `update_cart`/
  // `remove_from_cart`'s wire schema requires a real Medusa cart line-item
  // id, and the extraction schema only ever gives the model a loose NL
  // `item` reference (identifiers are model-forbidden). Requires cartId to
  // already be present (threaded above by the `kind.startsWith("order.")`
  // block).
  if (
    (kind === "order.item.update" || kind === "order.item.remove") &&
    typeof out.itemId !== "string" &&
    typeof out.cartId === "string"
  ) {
    const cartId = out.cartId;
    const { itemAmbiguousCount: _staleAmbiguousCount, ...strippedOfAmbiguity } = out;
    out = strippedOfAmbiguity;
    const name = firstString(out.item, out.product, out.name, out.query);
    if (name) {
      const resolution = await resolveCartLineItem(cartId, name, channel, sessionId, customerId);
      if (resolution.kind === "found") {
        out = { ...out, itemId: resolution.itemId };
      } else if (resolution.kind === "ambiguous") {
        out = { ...out, itemAmbiguousCount: resolution.count };
      }
      // resolution.kind === "not_found": itemId stays unresolved — the
      // executor reports an honest not-found rather than guessing.
    }
    if (kind === "order.item.update") {
      out = { ...out, quantity: coerceQuantity(out.quantity) };
    }
  }
  // FE-D28 — order.review.submit: resolve the (Identity-class) productId from
  // the reviewed order's OWN line items (a purchase-bound review), keyed off the
  // model's optional NL `item` reference. orderId was already resolved by
  // applyAutoResolve's review special-case (resolveCustomerOrderReference — an
  // explicit `orderReference` display number or the most-recent fallback). A
  // single-product order resolves without an item reference; a multi-product
  // order needs one. NEVER guesses: an ambiguous/no-match resolution leaves
  // productId unset AND stamps `ctx.reviewProductUnresolved`, so the kernel
  // REFUSEs honestly (refuseUnresolvedReviewProductGuard, compose-policy-packs.ts)
  // rather than parking a doomed "Confirma?" behind confirmOnAutoResolveGuard —
  // the same honest-floor posture as order.amend.add_item's FE-D18 guard. The
  // model's `item`/`orderReference` reference fields ride along unstripped (the
  // wire tool's SubmitReviewInputSchema.parse drops them from the Prisma write);
  // keeping them mirrors the granular-amend `item` precedent and preserves the
  // audited extraction IR. When orderId did NOT resolve, the flag is left unset
  // so requireOrderIdForMutation surfaces the specific "which order?" reply.
  if (
    kind === "order.review.submit" &&
    typeof out.productId !== "string" &&
    typeof out.orderId === "string"
  ) {
    const name = firstString(out.item, out.product, out.name, out.query);
    const resolution = await resolveReviewedProduct(out.orderId, name, customerId);
    if (resolution.kind === "found") {
      out = { ...out, productId: resolution.productId };
    } else {
      ctx.reviewProductUnresolved = true;
    }
  }
  // FE-T14 — customer.preferences.update: `allergenExclusions` is REQUIRED
  // on the wire (`CustomerPreferencesUpdatePayload`) and the executor
  // (update-preferences.ts) hard-REFUSEs when it is not an explicit array —
  // but it is NEVER on this capability's extraction schema (safety-critical,
  // Hard Rule #1: allergens are never model-inferred from conversation
  // text). UNCONDITIONALLY stripped from whatever the payload carries
  // (mirroring the order.item.add allergens precedent above — a smuggled
  // array must never survive unexamined) and refilled from the customer's
  // CURRENT saved preferences, so an ordinary "sou vegetariano" (touching
  // only dietaryFlags/favoriteCategories) can never silently wipe out an
  // already-declared allergy. A customer with no saved preferences row yet
  // defaults to `[]` (the same "no exclusions" default the domain service's
  // own upsert path uses) — never REFUSEs the turn just because the
  // customer never explicitly set allergens before.
  if (kind === "customer.preferences.update") {
    const { allergenExclusions: _modelSuppliedAllergenExclusions, ...strippedOfAllergens } = out;
    out = strippedOfAllergens;
    try {
      const { customerPrefs } = await createCustomerService().getProfileData(customerId);
      out = {
        ...out,
        allergenExclusions: Array.isArray(customerPrefs?.allergenExclusions)
          ? customerPrefs.allergenExclusions
          : [],
      };
    } catch {
      // Fail-closed to the safest "no exclusions known" default rather than
      // leaving the field unresolved — the executor REFUSEs on a missing
      // array either way, so a transient read error degrades to the same
      // honest REFUSE the guard already produces for a genuinely new
      // customer, never a silent bypass.
      out = { ...out, allergenExclusions: [] };
    }
  }
  return out;
}

/** Positive-integer coercion for order.item.add quantity (review B3). */
function coerceQuantity(raw: unknown): unknown {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed > 0) return parsed;
    }
  }
  return raw;
}

// BKL-199 — deterministic pt-BR NL→quantity parsing for order.item.add.
// The 4B routinely DROPS the stated number ("dois Refrigerantes" / "40 Brisket"
// → payload quantity absent → coerceQuantity defaults to 1), so a customer
// ordering 2/3/40 silently gets 1 — and the ≥R$1k confirm band is unreachable
// because no big order can be built. Same discipline as NL→variantId (BKL-061):
// never trust the model to carry the integer; derive it deterministically from
// the customer's own words. A resolution miss falls back to today's behavior
// (coerceQuantity → 1), so this is a strict, safe superset.

/** Accent-stripped pt-BR cardinals (normalizeTokens folds diacritics). A chat
 *  order of one line item beyond ~twenty is implausible; digits cover the rest. */
const PT_BR_CARDINALS: Readonly<Record<string, number>> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20,
};

// A parsed quantity above this is far likelier a misparse (a size/volume/price
// token — "600" in "600ml") than a real per-line count, so it is NOT treated as
// a quantity (falls back to the model value / default). "40 brisket" stays legit.
const MAX_NL_QUANTITY = 99;

/** Parse a single normalized token as a quantity: a pt-BR cardinal word, a bare
 *  1-2 digit number, or an "Nx"/"xN" form. Returns undefined for anything else
 *  or an out-of-range value. */
function quantityFromToken(token: string): number | undefined {
  const cardinal = PT_BR_CARDINALS[token];
  if (cardinal !== undefined) return cardinal;
  const digit = /^(\d{1,2})$/.exec(token) ?? /^(\d{1,2})x$/.exec(token) ?? /^x(\d{1,2})$/.exec(token);
  if (digit) {
    const n = Number.parseInt(digit[1]!, 10);
    if (n >= 1 && n <= MAX_NL_QUANTITY) return n;
  }
  return undefined;
}

/** First quantity token anywhere in a SHORT phrase (the model's item reference —
 *  e.g. "dois refrigerantes", "40 brisket", "2x farofa"). */
function quantityInPhrase(phrase: string): number | undefined {
  for (const tok of normalizeTokens(phrase)) {
    const q = quantityFromToken(tok);
    if (q !== undefined) return q;
  }
  return undefined;
}

/** Reference-position stopwords: skipped when locating the item head noun so a
 *  quantity in the "N [de] ITEM" slot is still adjacent. */
const ITEM_REF_STOPWORDS: ReadonlySet<string> = new Set([
  "o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das", "mais",
]);

/** Locate the item's head noun in the full utterance and read the quantity in
 *  the slot immediately before it (up to 2 tokens back, skipping stopwords). This
 *  catches the common case where the model stripped the number from `item`
 *  ("40 brisket" → item "brisket") but the utterance still says "…40 brisket…".
 *  Position-bounded so an unrelated number ("600ml") never counts. */
function quantityBeforeItem(utterance: string, itemRef: string): number | undefined {
  const uttTokens = normalizeTokens(utterance);
  const headTokens = normalizeTokens(itemRef).filter((t) => !ITEM_REF_STOPWORDS.has(t));
  if (uttTokens.length === 0 || headTokens.length === 0) return undefined;
  const head = headTokens[0]!;
  // Forgiving match (singular/plural: item "refrigerante" vs utterance
  // "refrigerantes") — substring both ways for content words ≥3 chars, exact
  // otherwise (a 1-2 char token would over-match). Mirrors resolveReviewedProduct.
  const matches = (t: string): boolean =>
    head.length >= 3 ? t.includes(head) || head.includes(t) : t === head;
  const idx = uttTokens.findIndex(matches);
  if (idx <= 0) return undefined;
  // Nearest first: the token right before the noun, then one more back past a stopword.
  for (let back = 1; back <= 2 && idx - back >= 0; back++) {
    const tok = uttTokens[idx - back]!;
    const q = quantityFromToken(tok);
    if (q !== undefined) return q;
    if (!ITEM_REF_STOPWORDS.has(tok)) break; // a non-stopword, non-quantity token ends the slot
  }
  return undefined;
}

/** BKL-199 — resolve order.item.add quantity: the customer's stated number wins
 *  over the model's (dropped) emission. Try the model's item phrase, then the
 *  utterance adjacent to the item; only fall back to coerceQuantity (string
 *  coerce / default 1) when the customer stated no parseable quantity. */
function deriveItemQuantity(
  modelQuantity: unknown,
  itemRef: string | undefined,
  utteranceText: string | undefined,
): unknown {
  if (itemRef) {
    const inPhrase = quantityInPhrase(itemRef);
    if (inPhrase !== undefined) return inPhrase;
    if (utteranceText) {
      const adjacent = quantityBeforeItem(utteranceText, itemRef);
      if (adjacent !== undefined) return adjacent;
    }
  }
  return coerceQuantity(modelQuantity);
}

/** Party-size head nouns a "para N pessoas" phrase attaches to. */
const PARTY_SIZE_NOUNS: readonly string[] = [
  "pessoas", "pessoa", "lugares", "lugar", "convidados", "convidado", "gente",
];

/** Change-target prepositions: the count that follows one is the NEW party size
 *  ("muda para 4 pessoas"). A count after "de"/"da"/"do" is the CURRENT/descriptive
 *  size ("muda a reserva DE 4 pessoas para as 20h") — must NOT be treated as the
 *  new value, so a time-only modify is never corrupted into a party-size change. */
const PARTY_SIZE_TARGET_PREPOSITIONS: ReadonlySet<string> = new Set(["para", "pra", "pro"]);
const PARTY_SIZE_SKIP_BEFORE_COUNT: ReadonlySet<string> = new Set([
  "as", "os", "a", "o", "de", "da", "do",
]);

/** BKL-227 — recover a reservation party-size the model DROPPED. Same class as
 *  BKL-199's item quantity: the 4B emits `reservation.modify` for "muda minha
 *  reserva para 4 pessoas" but leaves `newPartySize` unset, so the modify EXECUTEs
 *  as a NO-OP (nothing changes). Scan for a party-size head noun, read the count in
 *  the slot before it, and accept it ONLY when governed by a change-target
 *  preposition ("para"/"pra") — never a "de N pessoas" descriptive/current mention.
 *  Reservation party range is 1–20; a match outside it is ignored. */
function partySizeFromUtterance(utterance: string | undefined): number | undefined {
  if (!utterance) return undefined;
  const toks = normalizeTokens(utterance);
  for (let i = 1; i < toks.length; i++) {
    if (!PARTY_SIZE_NOUNS.includes(toks[i]!)) continue;
    // Walk back to the count immediately before the noun, skipping filler
    // ("para 4 [as] pessoas"). Track the token governing the count.
    let j = i - 1;
    while (j >= 0 && PARTY_SIZE_SKIP_BEFORE_COUNT.has(toks[j]!) && quantityFromToken(toks[j]!) === undefined) j--;
    if (j < 0) continue;
    const n = quantityFromToken(toks[j]!);
    if (n === undefined || n < 1 || n > 20) continue;
    // Require a change-target preposition somewhere in the two tokens before the
    // count (allows "para 4 pessoas" and "para as 4 pessoas"); reject "de 4 pessoas".
    const governing = [toks[j - 1], toks[j - 2]].filter((x): x is string => x !== undefined);
    if (governing.some((g) => PARTY_SIZE_TARGET_PREPOSITIONS.has(g))) return n;
    if (governing.some((g) => g === "de" || g === "da" || g === "do")) continue;
    // No explicit preposition ("reserva 4 pessoas") — accept (the common bare form).
    return n;
  }
  return undefined;
}

/** BKL-227 — for reservation.modify only, stamp a utterance-recovered
 *  `newPartySize` when the model didn't emit one, so the change actually applies.
 *  Byte-identical for every other kind and whenever the model DID emit the field
 *  (its value wins) or the utterance carries no parseable party size. */
function recoverModifyPartySize(kind: string, payload: Ctx, utteranceText: string | undefined): Ctx {
  if (kind !== "reservation.modify") return payload;
  if (typeof payload.newPartySize === "number") return payload;
  const n = partySizeFromUtterance(utteranceText);
  if (n === undefined) return payload;
  return { ...payload, newPartySize: n };
}

/**
 * Dispatch by kind to the right loader. Unknown / whatsapp kinds get the identity
 * base only (guards needing entity state see null → REFUSE cleanly, never panic).
 */
async function loadCtxForKind(
  kind: string,
  base: Ctx,
  customerId: string,
  resolvedPayload: Ctx,
  orderId: string | null,
  sessionId: string | undefined,
): Promise<Ctx> {
  if (kind.startsWith("payment.")) {
    return loadPaymentCtx(base, customerId, orderId);
  }
  if (ORDER_BY_ID_KINDS.has(kind)) {
    return loadOrderCtx(base, customerId, orderId);
  }
  if (kind.startsWith("reservation.")) {
    return loadReservationCtx(base, customerId, resolvedPayload);
  }
  if (kind.startsWith("customer.")) {
    return loadCustomerCtx(base, customerId);
  }
  if (kind.startsWith("order.")) {
    // Remaining order.* are cart/draft ops (ensure/item.*/checkout/coupon).
    return loadCartCtx(base, resolvedPayload, {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(typeof resolvedPayload.cartId === "string"
        ? { cartId: resolvedPayload.cartId }
        : {}),
    });
  }
  return { ...base, cartId: null, orderId, items: undefined };
}

/**
 * CONDUCTOR entry: build the identity base + F4 token counter, then dispatch by
 * kind to the right loader. Unknown / whatsapp kinds get the identity base only
 * (guards needing entity state see null → REFUSE cleanly, never panic).
 */
export async function resolveAndAssemble(args: ResolveArgs): Promise<AssembledResolution> {
  const { kind, payload, customerId, channel, sessionId, utteranceText } = args;
  const base = identityCtx(customerId, channel);
  base.sessionTokensConsumed = await readSessionTokensConsumed(channel, customerId);

  // T3-4 — agent-session budget read into ctx.agentTokensConsumed (undefined for
  // a normal conversational turn).
  const agentTokens = await readAgentSessionTokens(channel, sessionId);
  if (agentTokens !== undefined) base.agentTokensConsumed = agentTokens;

  // FE-T12/FE-T14 — wire→internal field renames, first and unconditional
  // (no dependency on auto-resolve/ownership). Every rename is independent
  // on the SAME payload — order between them doesn't matter (each only
  // touches its own key(s), and each is a no-op for every OTHER kind).
  const normalizedPayload = recoverModifyPartySize(
    kind,
    mapPreferencesUpdateWireFields(
      kind,
      mapCheckoutDeliveryTypeWireField(kind, mapCheckoutPaymentMethodWireField(kind, payload)),
    ),
    utteranceText,
  );

  // NL→id resolution (confirm-first) then the 034-F1 refund ownership binding.
  const auto = await applyAutoResolve(kind, normalizedPayload, customerId, utteranceText);
  const autoResolvedMoneyRef = auto.autoResolvedMoneyRef;
  const boundPayload = await bindRefundOwnership(kind, auto.payload);
  // FE-D27 — ground an NL date/time to a REAL timeSlotId (create/waitlist) or
  // newTimeSlotId (modify) when no listed slot was chosen. Runs AFTER applyAutoResolve
  // so a modify's reservationId (its party-size source) is already resolved.
  const resolvedPayload = await resolveReservationSlot(kind, boundPayload, customerId);

  const orderId =
    typeof resolvedPayload.orderId === "string" ? resolvedPayload.orderId : null;

  const ctx = await loadCtxForKind(
    kind,
    base,
    customerId,
    resolvedPayload,
    orderId,
    sessionId,
  );

  if (autoResolvedMoneyRef) ctx.autoResolvedMoneyRef = true;

  // FE-T14 — stamp the allergen-mention ctx flag `refuseAllergenMentionGuard`
  // (compose-policy-packs.ts, an ADOPTER business guard) reads to REFUSE an
  // allergen-shaped customer.preferences.update honestly, rather than let
  // the unconditional allergenExclusions strip+refill above silently
  // succeed as a no-op on exactly the turn where the customer asked to
  // change their allergies.
  if (kind === "customer.preferences.update" && isAllergenMentionUtterance(utteranceText)) {
    ctx.allergenMentionDetected = true;
  }

  // BKL-280 — stamp the stay-home/delivery-request ctx flag
  // `confirmDeliveryContradiction` (pack-orders/src/policies.ts) reads to ask a
  // customer whether they really meant RETIRADA, when their own words asked for
  // entrega but the model filled `delivery_type: pickup`.
  //
  // Derived from the customer's OWN utterance, NEVER from the model's payload —
  // the flag is the one input in this decision the model cannot author, which is
  // the entire point of moving the check outside it (owner ruling, Option B).
  //
  // Stamped ONLY for `order.checkout.create`: the marker words are ordinary
  // Portuguese and appear in cancel reasons ("endereço de entrega incorreto")
  // and coverage questions ("vocês entregam em Ibaté?"), so a kind gate keeps
  // the flag off every envelope whose guard could not use it anyway.
  //
  // ABSENT ON THE RESUME PATH BY CONSTRUCTION, and that is correct rather than a
  // gap: `enrichResumeState` (claustrum-bootstrap.ts) re-adjudicates a PARKED
  // envelope by calling `resolveAndAssemble` with no `utteranceText`, so the flag
  // is undefined, the guard returns null, and a confirm-resume behaves EXACTLY as
  // it does today. That is what keeps this change purely ADDITIVE — the money
  // band ladder and every existing checkout verdict are untouched on resume.
  if (kind === "order.checkout.create" && hasStayHomeDeliveryMarker(utteranceText)) {
    ctx.stayHomeDeliveryMarker = true;
  }

  // LE2-021 — the reorder-last anchor's grounding read. Additive, owner-scoped,
  // auth-gated, and identical on the resume path (see the helper's own doc).
  await stampPreviousOrderCtx(ctx, base, kind, customerId);

  // LE2-023 — the swap-for-coupon anchor's coupon read. ORDER-DEPENDENT: it
  // prices the coupon against the total the stamp above just resolved.
  await stampCouponSwapCtx(ctx, base, kind, resolvedPayload);

  // 034-F1: the ownership-confirmed resource set for the kernel authority graph.
  // ONLY ids the customer-scoped load actually returned (resourceOwnerConfirmed)
  // are included — a forged/other-principal orderId is never here, so the kernel
  // ownership guard REFUSEs it (de-vacuumed: the store can't bind what isn't owned).
  const owned: string[] =
    orderId !== null && ctx.resourceOwnerConfirmed === true ? [orderId] : [];

  // 034-F1 (finding 11): an ownership-confirmable load (loadOrderCtx /
  // loadPaymentCtx — the only loaders that set resourceOwnerConfirmed) that THREW
  // leaves resourceOwnerConfirmed undefined with a resolved orderId. Signal that to
  // the resolver so it leaves the guard inert instead of REFUSE-ing the TRUE owner
  // on a transient DB error. (A genuine cross-principal id yields false, not
  // undefined → owned=[] → correct REFUSE — unaffected.)
  const ownershipIndeterminate =
    orderId !== null &&
    (kind.startsWith("payment.") || ORDER_BY_ID_KINDS.has(kind)) &&
    ctx.resourceOwnerConfirmed === undefined;

  // F3/L1 (D-014): thread the session-resolved cartId (and reservation
  // customerId) from ctx onto the payload the executor tool receives, so cart
  // mutations no longer EXECUTE-then-ZodError on a missing cartId.
  const threadedPayload = await threadResolvedIdsIntoPayload(
    kind,
    resolvedPayload,
    ctx,
    customerId,
    channel,
    sessionId,
    utteranceText,
  );

  return { payload: threadedPayload, ctx, owned, ownershipIndeterminate };
}
