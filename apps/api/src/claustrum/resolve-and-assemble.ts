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

import { getRedisClient, rk, medusaStore, reaisToCentavos, searchProducts } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import {
  createOrderQueryService,
  createPaymentQueryService,
  createCustomerService,
  createReservationService,
  prisma,
} from "@ibatexas/domain";
import { parseAgentSessionNamespace } from "./agent-guards.js";

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
// would EXECUTE against a silently-guessed target. The granular amend kinds
// (add_item/update_qty/remove_item) are deliberately absent — they carry an
// explicit orderId from the amend flow, so there is nothing to auto-resolve.
const ORDER_AUTORESOLVE_KINDS = new Set([
  "order.cancel",
  "payment.pix.regenerate",
  "order.amend.request",
  "order.note.add",
  "order.address.change",
  "order.type.switch",
]);
const RESERVATION_AUTORESOLVE_KINDS = new Set(["reservation.cancel"]);

// 034-F1 (review finding 6/7): refund payloads (PaymentRefundIssuePayload /
// PaymentRefundConfirmPayload) carry ONLY paymentId — never orderId. Since
// ownership flows through the order, the kernel ownership guard had no resource to
// bind and ran INERT for every refund. These kinds resolve their owning orderId
// from the paymentId so loadPaymentCtx can confirm ownership and the authority
// graph engages. This is an ownership BINDING only — the refund target stays the
// explicit paymentId — so it does NOT force a confirm like the NL autoresolve path.
const REFUND_OWNERSHIP_KINDS = new Set(["payment.refund.issue", "payment.refund.confirm"]);

/** NL→id: explicit orderId wins; else auto-resolve the customer's most-recent order. */
async function resolveOrderId(
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

/** NL→id: explicit reservationId wins; else auto-resolve the only ACTIVE reservation. */
async function resolveReservationId(
  payload: Ctx,
  customerId: string,
): Promise<{ reservationId: string | null; autoResolved: boolean }> {
  if (typeof payload.reservationId === "string") {
    return { reservationId: payload.reservationId, autoResolved: false };
  }
  try {
    const { reservations } = await createReservationService().listByCustomer(customerId, {
      limit: 10,
    });
    const active = (reservations as Array<{ id: string; status: string }>).filter(
      (r) => r.status === "pending" || r.status === "confirmed",
    );
    // Only auto-resolve when unambiguous (exactly one active booking); otherwise
    // leave it for the agent to clarify which one.
    return active.length === 1
      ? { reservationId: active[0]!.id, autoResolved: true }
      : { reservationId: null, autoResolved: false };
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
): Promise<{ payload: Ctx; autoResolvedMoneyRef: boolean }> {
  if (ORDER_AUTORESOLVE_KINDS.has(kind)) {
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
  }
  return { payload, autoResolvedMoneyRef: false };
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

/**
 * F3/L1 (BKL-061) — deterministic NL→variantId resolution (a READ; keeps this
 * module's read-only invariant). The 4B emits order.item.add with a LOOSE
 * product name (e.g. `{item:"coca cola"}`) — no variantId. Resolve it via
 * Typesense (`searchProducts`) so the executor's schema (which requires
 * variantId) is satisfiable. Returns undefined on no-match/error → the tool
 * REFUSEs honestly ("não encontrei esse item") rather than adding the wrong one.
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

async function threadResolvedIdsIntoPayload(
  kind: string,
  payload: Ctx,
  ctx: Ctx,
  customerId: string,
  channel: string,
  sessionId: string | undefined,
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
  // BKL-061 + BKL-067: order.item.add — resolve a loose product name to the
  // product (READ) and inject variantId + the product's EXPLICIT allergens
  // (pack-orders requireExplicitAllergens; Hard Rule #1) + default quantity, so
  // the executor schema {cartId,variantId,quantity} AND the allergen guard are
  // satisfiable from the 4B's loose emission. cartId comes from BKL-028 (session
  // cart) which BKL-066 ensures exists.
  if (kind === "order.item.add") {
    const needsVariant = typeof out.variantId !== "string";
    const needsAllergens = !Array.isArray(out.allergens);
    if (needsVariant || needsAllergens) {
      const name = firstString(out.item, out.product, out.productName, out.name, out.query);
      if (name) {
        const resolved = await resolveProductForItem(name, channel, sessionId, customerId);
        if (resolved !== undefined) {
          if (needsVariant && resolved.variantId !== undefined) {
            out = { ...out, variantId: resolved.variantId };
          }
          if (needsAllergens && Array.isArray(resolved.allergens)) {
            out = { ...out, allergens: resolved.allergens };
          }
        }
      }
    }
    // Review B3: the 4B often emits quantity as a STRING ("2") — the old
    // `typeof !== "number" → 1` silently rewrote "2 costelas" to quantity 1.
    // Coerce a positive-integer string; default only when ABSENT. A present
    // but invalid value (0, negatives, fractions, junk) is left untouched so
    // AddToCartInputSchema refuses loudly and the customer gets a clarify —
    // never a silently different quantity.
    out = { ...out, quantity: coerceQuantity(out.quantity) };
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
  const { kind, payload, customerId, channel, sessionId } = args;
  const base = identityCtx(customerId, channel);
  base.sessionTokensConsumed = await readSessionTokensConsumed(channel, customerId);

  // T3-4 — agent-session budget read into ctx.agentTokensConsumed (undefined for
  // a normal conversational turn).
  const agentTokens = await readAgentSessionTokens(channel, sessionId);
  if (agentTokens !== undefined) base.agentTokensConsumed = agentTokens;

  // NL→id resolution (confirm-first) then the 034-F1 refund ownership binding.
  const auto = await applyAutoResolve(kind, payload, customerId);
  const autoResolvedMoneyRef = auto.autoResolvedMoneyRef;
  const resolvedPayload = await bindRefundOwnership(kind, auto.payload);

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
  );

  return { payload: threadedPayload, ctx, owned, ownershipIndeterminate };
}
