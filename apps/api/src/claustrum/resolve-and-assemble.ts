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
import { Channel } from "@ibatexas/types";
import {
  createOrderQueryService,
  createOrderService,
  createPaymentQueryService,
  createCustomerService,
  createReservationService,
  prisma,
} from "@ibatexas/domain";
import { parseAgentSessionNamespace } from "./agent-guards.js";
// FE-T13 — reuse the ops-plane displayId parser (pure, no ops-specific
// dependency) rather than re-deriving the same `#1234`-style parse rule.
import { parseDisplayIdRef } from "../ops/ops-order-resolution.js";

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
const ORDER_AUTORESOLVE_KINDS = new Set([
  "order.cancel",
  "payment.pix.regenerate",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.note.add",
  "order.address.change",
  "order.type.switch",
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
const RESERVATION_AUTORESOLVE_KINDS = new Set(["reservation.cancel", "reservation.modify"]);

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
export async function resolveCustomerOrderReference(
  orderReference: string | undefined,
  customerId: string,
): Promise<{ orderId: string | null; autoResolved: boolean; referenceMatched: boolean }> {
  if (typeof orderReference === "string") {
    const displayId = parseDisplayIdRef(orderReference);
    if (displayId !== null) {
      try {
        const candidates = await createOrderQueryService().findByDisplayId(displayId);
        const owned = candidates.find((o) => o.customerId === customerId);
        if (owned) {
          return { orderId: owned.id, autoResolved: false, referenceMatched: true };
        }
      } catch {
        // Fail-safe — fall through to auto-resolve below, same posture as
        // resolveOrderId's own try/catch.
      }
    }
  }
  const { orderId, autoResolved } = await resolveOrderId({}, customerId);
  return { orderId, autoResolved, referenceMatched: false };
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
    // Review B3: the 4B often emits quantity as a STRING ("2") — the old
    // `typeof !== "number" → 1` silently rewrote "2 costelas" to quantity 1.
    // Coerce a positive-integer string; default only when ABSENT. A present
    // but invalid value (0, negatives, fractions, junk) is left untouched so
    // AddToCartInputSchema refuses loudly and the customer gets a clarify —
    // never a silently different quantity.
    out = { ...out, quantity: coerceQuantity(out.quantity) };
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
  const normalizedPayload = mapPreferencesUpdateWireFields(
    kind,
    mapCheckoutDeliveryTypeWireField(kind, mapCheckoutPaymentMethodWireField(kind, payload)),
  );

  // NL→id resolution (confirm-first) then the 034-F1 refund ownership binding.
  const auto = await applyAutoResolve(kind, normalizedPayload, customerId);
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

  // FE-T14 — stamp the allergen-mention ctx flag `refuseAllergenMentionGuard`
  // (compose-policy-packs.ts, an ADOPTER business guard) reads to REFUSE an
  // allergen-shaped customer.preferences.update honestly, rather than let
  // the unconditional allergenExclusions strip+refill above silently
  // succeed as a no-op on exactly the turn where the customer asked to
  // change their allergies.
  if (kind === "customer.preferences.update" && isAllergenMentionUtterance(utteranceText)) {
    ctx.allergenMentionDetected = true;
  }

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
