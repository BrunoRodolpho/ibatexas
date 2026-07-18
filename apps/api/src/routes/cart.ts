// Cart proxy routes — forward cart operations to Medusa Store API
//
// POST   /api/cart                          — create cart
// GET    /api/cart/:id                      — get cart
// POST   /api/cart/:id/line-items           — add line item
// DELETE /api/cart/:id/line-items/:itemId   — remove line item
// PATCH  /api/cart/:id/line-items/:itemId   — update line item quantity
// POST   /api/cart/:id/promotions           — apply promotion code
// POST   /api/cart/:id/payment-sessions     — initialize payment sessions
// POST   /api/cart/checkout                 — complete checkout (PIX/card/cash)
// GET    /api/cart/delivery-estimate        — delivery fee by CEP
// GET    /api/cart/orders/:orderId          — order details
// POST   /api/coupons/validate             — validate coupon code
//
// All session cart IDs are tracked in Redis active:carts set for abandoned-cart detection.

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildCustomerEnvelope, runCustomerIntent } from "./__shared__/customer-intent-gateway.js";
import { createCheckoutConfirmationStore } from "./checkout-confirmation-store.js";
import { identityCtx, loadCartCtx } from "../claustrum/resolve-and-assemble.js";
import {
  getRedisClient,
  rk,
  estimateDelivery,
  createCheckout,
  reaisToCentavos,
  MedusaRequestError,
  cancelStalePaymentIntent,
  loadSchedule,
  getMealPeriodFromSchedule,
  medusaAdjudicated,
  MedusaAdjudicateRefusedError,
  MedusaAdjudicateDeferredError,
  MedusaAdjudicateNeedsReviewError,
  isValidCpf,
  normalizeCpf,
  createOrderAccessToken,
  verifyOrderAccessToken,
  getTypesenseClient,
  COLLECTION,
} from "@ibatexas/tools";
import { Channel, COUPON_REJECTED_CODE, type UserType } from "@ibatexas/types";
import { createCustomerService, createOrderCommandService, createPaymentQueryService, prisma } from "@ibatexas/domain";
import { ordersPolicyBundle, type OrderCartSyncPayload, type OrderCheckoutCreatePayload, type OrderNoteAddPayload, type OrderState } from "@ibatexas/pack-orders";
import { portugueseRefusalMessages } from "@ibatexas/pack-orders";
import {
  type CustomerOnboardingState,
  type CustomerPixDetailsSavePayload,
} from "@ibatexas/pack-customer-onboarding";
import { getAuditSink } from "@ibatexas/audit-sink";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { medusaStore, medusaAdmin } from "./admin/_shared.js";

// ── P0-X9 migration helpers ────────────────────────────────────────────────
//
// Cart routes go through medusaAdjudicated for every mutating Medusa
// egress. The wrapper enforces SYSTEM taint internally (per Task 17:
// every Medusa hop originates inside the IbateXas process). The OUTER
// customer-intent envelope (UNTRUSTED user actor) is handled by
// runCustomerIntent on routes that need it (checkout already does).
//
// `mapMedusaErrorToReply` translates the wrapper's typed errors into
// pt-BR HTTP responses: REFUSE → 403, DEFER → 202, NEEDS_REVIEW → 503.
// Returns true when the error was handled (the caller must NOT send
// another response).
function mapMedusaErrorToReply(err: unknown, reply: FastifyReply): boolean {
  if (err instanceof MedusaAdjudicateRefusedError) {
    void reply.code(403).send({ error: err.userFacing, code: err.code });
    return true;
  }
  if (err instanceof MedusaAdjudicateDeferredError) {
    void reply.code(202).send({
      status: "deferred",
      signal: err.signal,
      message: "Operação aguardando confirmação.",
    });
    return true;
  }
  if (err instanceof MedusaAdjudicateNeedsReviewError) {
    void reply.code(503).send({
      error: "Operação requer atendimento humano.",
    });
    return true;
  }
  return false;
}

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

/** Supported checkout payment methods (mirrors the `z.enum(["pix","card","cash"])`
 *  body schema on POST /api/cart/checkout). */
type PaymentMethod = "pix" | "card" | "cash";

// ── P0-7 (audit-2026-05-24) — deterministic idempotency-key helpers ────────
//
// Replays of the same logical operation MUST produce the same envelope
// `intentHash` so the kernel's Execution Ledger can dedupe. The route
// derives a stable idempotency key from non-PII identifiers (cartId,
// orderId, customerId — all UUIDs) and SHA-256s it into the envelope's
// `nonce`. Callers may override with an explicit `Idempotency-Key`
// header (industry standard, e.g. Stripe).
function deriveCartNonce(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function resolveCartIdempotencyKey(
  headerValue: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue[0]) {
    return headerValue[0];
  }
  return fallback;
}

const PIX_CACHE_TTL = 90 * 86400; // 90 days

async function loadCachedPixDetails(
  customerId: string,
): Promise<{ name?: string; email?: string; cpf?: string } | null> {
  try {
    const redis = await getRedisClient();
    const key = rk(`customer:pix:${customerId}`);
    const hash = await redis.hGetAll(key);
    if (hash && Object.keys(hash).length > 0) {
      await redis.expire(key, PIX_CACHE_TTL);
      return {
        name: hash.name || undefined,
        email: hash.email || undefined,
        cpf: hash.cpf || undefined,
      };
    }
    const svc = createCustomerService();
    const customer = await svc.getById(customerId);
    const cpf = (customer as Record<string, unknown>).cpf as string | null | undefined;
    if (customer.email || cpf) {
      return {
        name: customer.name ?? undefined,
        email: customer.email ?? undefined,
        cpf: cpf ?? undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Cache PIX details to Redis + persist to Prisma via the kernel-adjudicated
 *  `customer.pix.details.save` envelope. Exported for unit-test access.
 *  @internal */
export async function cachePixDetailsForCustomer(
  customerId: string,
  data: { name?: string; email?: string; cpf?: string },
): Promise<void> {
  try {
    const redis = await getRedisClient();
    const key = rk(`customer:pix:${customerId}`);
    const pipeline = redis.multi();
    if (data.name) pipeline.hSet(key, "name", data.name);
    if (data.email) pipeline.hSet(key, "email", data.email);
    if (data.cpf) pipeline.hSet(key, "cpf", data.cpf);
    pipeline.expire(key, PIX_CACHE_TTL);
    await pipeline.exec();

    // ── W7 — route DB persist through customer.pix.details.save envelope.
    //
    // The PII (name/email/CPF) was submitted by the customer via the
    // checkout form (or pulled from the cached pre-fill, both UNTRUSTED
    // origin). The pack's CPF-shape guard runs first; on REFUSE we skip
    // the DB write but keep the Redis cache (best-effort caching is the
    // existing semantics — a checkout that completed against Medusa is
    // already booked).
    const svc = createCustomerService({ auditSink: getAuditSink() });
    const payload: CustomerPixDetailsSavePayload = {
      name: data.name ?? "",
      email: data.email ?? "",
      cpf: data.cpf ?? "",
    };
    const envelope = buildCustomerEnvelope<
      "customer.pix.details.save",
      CustomerPixDetailsSavePayload
    >({
      kind: "customer.pix.details.save",
      payload,
      // audit-2026-05-25 (I10): deterministic nonce so retries of the
      // same logical PIX-details save (network blip → checkout retry)
      // dedupe via the kernel Execution Ledger. Pre-fix the
      // randomUUID() created a fresh intentHash on every successful
      // checkout, defeating ledger dedup and producing N audit records
      // + N Prisma updates for one logical save. Mirrors the
      // deterministic-key pattern at cart.ts:856 for the checkout
      // itself.
      nonce: `${customerId}:pix-details-save`,
      customerId,
    });
    const state: CustomerOnboardingState = {
      ctx: {
        actor: { principal: "user", id: customerId },
        customerId,
        customerExists: true,
        isAuthenticated: true,
        otpFresh: false,
        hasParkedAnonymize: false,
        now: new Date(),
      },
    };
    await svc.updatePixDetailsFromEnvelope(envelope, state, { customerId });
  } catch (err) {
    console.warn("[cart/checkout] Failed to cache PIX details:", (err as Error).message);
  }
}

const CartIdParams = z.object({ id: z.string().min(1) });
const CartItemParams = z.object({ id: z.string().min(1), itemId: z.string().min(1) });

// TTL on active:carts hash (48h = guest session max, prevents unbounded growth)
const ACTIVE_CARTS_TTL = 48 * 60 * 60; // 48h — matches max session TTL (guest)

/**
 * Register cartId in active:carts tracking hash for abandoned-cart detection.
 * Store {sessionType, lastActivity} so abandoned-cart-checker uses correct idle
 * threshold per session type.
 */
async function trackCartId(cartId: string, sessionType: "guest" | "customer" = "guest"): Promise<void> {
  const redis = await getRedisClient();
  const data = JSON.stringify({ cartId, sessionType, lastActivity: Date.now() });
  await redis.hSet(rk("active:carts"), cartId, data);
  await redis.expire(rk("active:carts"), ACTIVE_CARTS_TTL);
}

/** Remove cartId from active:carts (called when order is placed). */
export async function untrackCartId(cartId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.hDel(rk("active:carts"), cartId);
}

/**
 * SEC: Verify that the authenticated customer owns the cart.
 * Guest carts (no customerId) skip verification.
 * On first access by a customer, ownership is claimed.
 */
async function verifyCartOwnership(
  cartId: string,
  customerId: string | undefined,
  redis: RedisClient,
): Promise<boolean> {
  if (!customerId) return true; // Guest carts — no verification possible
  const ownerKey = rk(`cart:owner:${cartId}`);
  const owner = await redis.get(ownerKey);
  if (owner) return owner === customerId;

  // Atomic claim — only first caller wins
  const claimed = await redis.set(ownerKey, customerId, { EX: 86400, NX: true });
  if (claimed) return true;

  // Another request won the race — check if it was us
  const actualOwner = await redis.get(ownerKey);
  return actualOwner === customerId;
}

// Single-use store for parked large-ticket checkouts (REQUEST_CONFIRMATION).
// Stateless — receipts live in Redis; one module instance is fine.
const checkoutConfirmationStore = createCheckoutConfirmationStore();

/**
 * R0a — customer-facing order-read authorization (closes the null-owner IDOR).
 *
 * SDD Invariant 2 (§J.2): ownership is a VALIDATION predicate — a
 * `customer_scoped` resource with NO owner attribution is REFUSED, because
 * "no owner" ≠ "any owner". A lenient `owner && owner !== caller` guard
 * short-circuits to ALLOW when `owner` is null, leaking guest (null-`customer_id`)
 * orders to any anonymous `IBX-<n>` enumerator. This predicate denies null-owner
 * reads unless the caller proves entitlement.
 *
 * A read is authorized iff EITHER:
 *   - the caller is the authenticated owner (`request.customerId` set AND equal
 *     to the order's owner), OR
 *   - the caller presents a valid signed per-order access token BOUND to this
 *     exact `orderId` (the guest-tracking path — PLAN decision (a); minted at
 *     checkout, HMAC over orderId + short TTL).
 *
 * No owner match and no valid token ⇒ the caller gets a 404 (existence-masking).
 */
function isOrderReadAuthorized(args: {
  orderCustomerId: string | null | undefined;
  requestCustomerId: string | undefined;
  orderIdParam: string;
  accessToken: string | undefined;
}): boolean {
  const { orderCustomerId, requestCustomerId, orderIdParam, accessToken } = args;
  // Owner match — authenticated caller IS the order's owner. A null owner never
  // matches (Inv 2: "no owner" ≠ "any owner").
  if (requestCustomerId && orderCustomerId && requestCustomerId === orderCustomerId) {
    return true;
  }
  // Signed per-order guest token bound to THIS order.
  if (accessToken && verifyOrderAccessToken(accessToken, orderIdParam)) {
    return true;
  }
  return false;
}

/**
 * Shared post-checkout finalize: apply the money-path side effects + shape
 * the response. Used by BOTH `POST /api/cart/checkout` (EXECUTE) and
 * `POST /api/cart/checkout/confirm` so the two paths never drift.
 */
async function finalizeCheckout(args: {
  reply: FastifyReply;
  result: Awaited<ReturnType<typeof createCheckout>>;
  cartId: string;
  paymentMethod: PaymentMethod;
  customerId: string | undefined;
  pixExtra?: { customerName?: string; customerEmail?: string; customerTaxId?: string };
  notes?: string;
  /**
   * Called on a fixable (400) failure before responding — e.g. release the
   * checkout idempotency gate so the customer can correct + retry without
   * waiting out the 120s TTL. Omitted on the confirm path (no gate held;
   * the single-use receipt already prevents a double-confirm).
   */
  onFixableFailure?: () => Promise<void>;
}): Promise<FastifyReply> {
  const { reply, result, cartId, paymentMethod, customerId, pixExtra, notes, onFixableFailure } = args;

  if (!result.success) {
    if (onFixableFailure) await onFixableFailure();
    // D1 — Medusa rejected the coupon: the tool aborted BEFORE any payment
    // collection was created (fail-closed money path). Surface a 422 in the
    // route's rejection shape; `error` carries the pt-BR copy because the
    // web checkout renders `data.error ?? data.message`.
    if (result.code === COUPON_REJECTED_CODE) {
      return reply.status(422).send({
        statusCode: 422,
        error: result.message,
        message: result.message,
        code: COUPON_REJECTED_CODE,
      });
    }
    return reply.status(400).send(result);
  }

  // Cache PIX details for authenticated customers on successful checkout
  if (paymentMethod === "pix" && customerId && pixExtra) {
    void cachePixDetailsForCustomer(customerId, {
      name: pixExtra.customerName,
      email: pixExtra.customerEmail,
      cpf: pixExtra.customerTaxId,
    });
  }

  // Untrack cart from abandoned-cart detection on successful checkout
  if (result.orderId) {
    await untrackCartId(cartId);
    const redis = await getRedisClient();
    await redis.del(rk(`cart:owner:${cartId}`));
  }

  // Persist customer notes as OrderNote — best-effort, never fails checkout.
  // W7-P4: routed through addNoteFromEnvelope so the order.note.add intent
  // is kernel-adjudicated and audit-emitted. The Wave-6 finding flagged the
  // direct prisma.orderNote.create as a parallel/duplicate surface bypass.
  if (notes && result.orderId) {
    await persistCheckoutOrderNote({ notes, orderId: result.orderId, customerId, cartId });
  }

  // R0a — mint a signed per-order access token so a GUEST (null-owner order)
  // can still authorize the order-tracking reads/polls after checkout. Authed
  // owners don't need it (cookie owner-match covers them) but returning it is
  // harmless.
  //
  // cash/PIX: the order exists now, so bind the token to result.orderId — the
  // same id the client navigates to /pedido/<id> with.
  //
  // card: the order is created LATER by the Stripe webhook, so there is no
  // orderId here. The guest tracks via /pedido/<paymentIntentId> (a `pi_…`
  // id), and the read guards (/orders/:orderId + /status) capture that RAW
  // caller-supplied id BEFORE resolving it to the Medusa order — so a token
  // bound to the paymentIntentId lines up exactly with the verify on that
  // `pi_…` id. Without this, a guest card checkout lands on /pedido/pi_… with
  // no token and the deny-null-owner guard 404s the webhook-created order.
  const accessToken = mintOrderAccessToken(result);
  return reply.send(accessToken ? { ...result, accessToken } : result);
}

// ── route-local logger alias + checkout helper types ───────────────────────
type RouteLog = FastifyInstance["log"];

/** A fixable/terminal checkout rejection: the HTTP status + pt-BR body the
 *  route sends verbatim. Lets the extracted validators return a decision
 *  without owning the `reply`. */
type CheckoutRejection = { status: number; body: Record<string, unknown> };

/** Medusa order shape used by the customer-facing order-read endpoint. */
type MedusaOrder = {
  id: string;
  status: string;
  display_id: number;
  total: number;
  subtotal: number;
  shipping_total: number;
  customer_id?: string;
  metadata?: Record<string, string>;
  items: Array<{
    id: string;
    title: string;
    quantity: number;
    unit_price: number;
    thumbnail?: string;
    variant_id?: string;
    metadata?: Record<string, string>;
  }>;
  created_at: string;
};

/** Result of resolving a caller-supplied order id to a Medusa order: either the
 *  (possibly absent) order, or a 202-pending body to surface. */
type ResolvedOrderRead =
  | { kind: "order"; order: MedusaOrder | undefined }
  | { kind: "pending"; body: Record<string, unknown> };

/** Computed order-status poll outcome: the HTTP status, the body, and whether
 *  to set Cache-Control: no-store. */
type StatusReadOutcome = { status: number; body: Record<string, unknown>; noStore: boolean };

/** Persist a customer's checkout note as an OrderNote — best-effort, never
 *  fails checkout. Routed through addNoteFromEnvelope so the order.note.add
 *  intent is kernel-adjudicated + audit-emitted (W7-P4). */
async function persistCheckoutOrderNote(args: {
  notes: string;
  orderId: string;
  customerId: string | undefined;
  cartId: string;
}): Promise<void> {
  const { notes, orderId, customerId, cartId } = args;
  try {
    const displayIdMatch = /^IBX-(\d+)$/i.exec(orderId);
    if (!displayIdMatch) return;
    const displayId = Number.parseInt(displayIdMatch[1], 10);
    const projection = await prisma.orderProjection.findFirst({
      where: { displayId },
      select: {
        id: true,
        customerId: true,
        paymentMethod: true,
        paymentStatus: true,
        totalInCentavos: true,
      },
    });
    if (!projection) return;
    const noteEnvelope = buildCustomerEnvelope<
      "order.note.add",
      OrderNoteAddPayload
    >({
      kind: "order.note.add" as const,
      payload: {
        orderId: projection.id,
        body: notes,
      },
      nonce: randomUUID(),
      customerId: customerId
        ? `customer:${customerId}`
        : `cart:${cartId}`,
    });
    const noteOrderState: OrderState = {
      ctx: {
        channel: "web",
        customerId: projection.customerId,
        cartId: null,
        orderId: projection.id,
        paymentMethod: (projection.paymentMethod as
          | "pix"
          | "card"
          | "cash"
          | null) ?? null,
        paymentStatus: projection.paymentStatus,
        totalInCentavos: projection.totalInCentavos,
      },
    };
    const orderCmdSvc = createOrderCommandService(undefined, {
      auditSink: getAuditSink(),
    });
    await orderCmdSvc.addNoteFromEnvelope(
      noteEnvelope,
      noteOrderState,
      {
        author: "customer",
        ...(customerId ? { authorId: customerId } : {}),
      },
    );
  } catch {
    // note persistence is best-effort
  }
}

/** Mint a signed per-order access token so a GUEST (null-owner order) can
 *  authorize order-tracking reads after checkout. cash/PIX bind the token to
 *  the order id; card binds to the Stripe paymentIntentId (the order is created
 *  later by the webhook). */
function mintOrderAccessToken(
  result: Awaited<ReturnType<typeof createCheckout>>,
): string | undefined {
  if (result.orderId) {
    return createOrderAccessToken(result.orderId);
  }
  if (result.paymentMethod === "card" && result.paymentIntentId) {
    return createOrderAccessToken(result.paymentIntentId);
  }
  return undefined;
}

/** Resolve the Medusa `customer_id` binding for a new cart when the caller is an
 *  authenticated customer with a linked Medusa id. Best-effort: on lookup
 *  failure the cart is created as a guest cart. */
async function resolveCustomerCartBody(
  customerId: string | undefined,
): Promise<Record<string, unknown>> {
  if (!customerId) return {};
  try {
    const customerSvc = createCustomerService();
    const customer = await customerSvc.getById(customerId);
    if (customer.medusaId) {
      return { customer_id: customer.medusaId };
    }
  } catch {
    // Customer lookup failed — create cart without binding (guest mode)
  }
  return {};
}

/** Cancel any live Stripe PaymentIntents on a cart's payment sessions so a
 *  replaced cart can't leave an orphaned QR code that still charges the
 *  customer. Best-effort per session. */
async function cancelStaleStripeSessions(
  sessions: Array<{ provider_id: string; data?: { id?: string } }>,
): Promise<void> {
  for (const session of sessions) {
    const piId = session.data?.id;
    if (piId && session.provider_id.includes("stripe")) {
      await cancelStalePaymentIntent(piId).catch(() => {});
    }
  }
}

/** Best-effort clear of a clean cart's existing line items before checkout
 *  re-adds the client's local items. The kernel may REFUSE on a terminal cart;
 *  that's surfaced via the wrapper's typed error and silenced here so the
 *  checkout flow can still proceed. */
async function clearExistingCartItems(
  cartId: string,
  items: Array<{ id: string }>,
  customerId: string | undefined,
  log: RouteLog,
): Promise<void> {
  for (const item of items) {
    await medusaAdjudicated<undefined, unknown>({
      scope: "store",
      method: "DELETE",
      path: `/store/carts/${cartId}/line-items/${item.id}`,
      intentKind: "medusa.cart.line_items.remove",
      idempotencyKey: `checkout-clear:${cartId}:${item.id}`,
      sourceSubject: `route:POST /api/cart/checkout:cust:${customerId ?? "guest"}`,
      auditSink: getAuditSink(),
      log,
    }).catch((err) => {
      log.warn(
        { err: (err as Error).message ?? String(err), itemId: item.id },
        "[cart/checkout] clear-existing-item failed — continuing",
      );
    });
  }
}

/** Inspect the customer's current Medusa cart and decide whether checkout must
 *  start a fresh cart. A completed cart or one with live payment sessions
 *  (Stripe PIs cancelled first to avoid orphan QR charges) forces a new cart; a
 *  clean cart just has its stale items cleared in place. A 404 (cart
 *  purged/expired) also forces a fresh cart. */
async function checkoutCartNeedsReplacement(args: {
  cartId: string;
  customerId: string | undefined;
  log: RouteLog;
}): Promise<boolean> {
  const { cartId, customerId, log } = args;
  try {
    const existingCart = await medusaStore(`/store/carts/${cartId}`) as {
      cart?: {
        completed_at?: string;
        items?: Array<{ id: string }>;
        payment_collection?: {
          id: string;
          payment_sessions?: Array<{ id: string; provider_id: string; data?: { id?: string } }>;
        };
      };
    };

    if (existingCart.cart?.completed_at) {
      return true;
    }
    const sessions = existingCart.cart?.payment_collection?.payment_sessions;
    if (sessions?.length) {
      // Cancel Stripe PIs to prevent orphaned QR codes from charging the customer
      await cancelStaleStripeSessions(sessions);
      return true;
    }
    // Cart is clean — just clear old items before re-adding
    await clearExistingCartItems(cartId, existingCart.cart?.items ?? [], customerId, log);
    return false;
  } catch (err) {
    // Cart doesn't exist in Medusa (purged/expired) — create fresh
    if (err instanceof MedusaRequestError && err.statusCode === 404) {
      return true;
    }
    throw err;
  }
}

/** Add the client's local cart items to the (possibly freshly created) Medusa
 *  cart during checkout. */
/**
 * BKL-180 — read a variant's DECLARED allergens array from the catalog (Typesense),
 * mirroring `add-to-cart.ts`'s `lookupProductByVariant` (the `resolveProductForItem`
 * catalog-read precedent). Reading DECLARED catalog data is Hard-Rule-#1-compliant —
 * the rule forbids INFERENCE (from a name/description), not reads of the product's own
 * declared `allergens` field. FAIL-CLOSED: a read failure, a missing variant, or a
 * doc with no declared `allergens` string[] returns `null` (the caller REFUSE-safes) —
 * NEVER fabricate `[]`. A DECLARED empty `[]` (the product explicitly has no allergens)
 * is a valid hydration.
 */
async function lookupDeclaredAllergensByVariant(variantId: string): Promise<string[] | null> {
  try {
    const client = getTypesenseClient();
    const results = await client.collections(COLLECTION).documents().search({
      q: variantId,
      query_by: "variantsJson",
      filter_by: "status:published",
      per_page: 1,
    });
    const doc = results.hits?.[0]?.document as { allergens?: unknown } | undefined;
    const a = doc?.allergens;
    return Array.isArray(a) && a.every((e) => typeof e === "string") ? (a as string[]) : null;
  } catch {
    return null;
  }
}

/** The per-line replay leg of the checkout sync. BKL-180 wires ONE governed
 *  `order.cart.sync` envelope IN FRONT of this (see `syncLocalCartForCheckout`); this
 *  function is the SOLE EXECUTE-side executor for that envelope, preserving the exact
 *  per-item `medusaAdjudicated` egress + `productType` metadata (no availability
 *  re-check at checkout — the checkout composition guard already ran). order.cart.sync
 *  is identity-tier/unadvertised and has no other caller, so there is no registered
 *  tool executor (a future non-checkout caller would register one THEN). */
async function addLocalItemsToCart(args: {
  cartId: string;
  localItems: Array<{ variantId: string; quantity: number; productType?: string }>;
  customerId: string | undefined;
  log: RouteLog;
}): Promise<void> {
  const { cartId, localItems, customerId, log } = args;
  for (const item of localItems) {
    await medusaAdjudicated<
      { variant_id: string; quantity: number; metadata?: { productType: string } },
      unknown
    >({
      scope: "store",
      method: "POST",
      path: `/store/carts/${cartId}/line-items`,
      payload: {
        variant_id: item.variantId,
        quantity: item.quantity,
        ...(item.productType ? { metadata: { productType: item.productType } } : {}),
      },
      intentKind: "medusa.cart.line_items.add",
      idempotencyKey: `checkout-add:${cartId}:${item.variantId}:${randomUUID()}`,
      sourceSubject: `route:POST /api/cart/checkout:cust:${customerId ?? "guest"}`,
      headers: { "Content-Type": "application/json" },
      auditSink: getAuditSink(),
      log,
    });
  }
}

/** Sync the client's local cart items into Medusa before checkout. Returns the
 *  cartId to check out against (a fresh one if the existing cart was completed /
 *  had live payment sessions / was purged), or a rejection if a new cart could
 *  not be created. */
async function syncLocalCartForCheckout(args: {
  cartId: string;
  localItems: Array<{ variantId: string; quantity: number; productType?: string }>;
  customerId: string | undefined;
  log: RouteLog;
}): Promise<{ cartId: string } | { rejection: CheckoutRejection }> {
  const { localItems, customerId, log } = args;
  let cartId = args.cartId;

  const needsNewCart = await checkoutCartNeedsReplacement({ cartId, customerId, log });

  if (needsNewCart) {
    // Bind customer to new cart so the order is linked to their account
    const newCartBody = await resolveCustomerCartBody(customerId);
    const newCart = await medusaAdjudicated<Record<string, unknown>, { cart?: { id: string } }>({
      scope: "store",
      method: "POST",
      path: "/store/carts",
      payload: newCartBody,
      intentKind: "medusa.cart.create",
      idempotencyKey: `checkout-new-cart:${cartId}:${randomUUID()}`,
      sourceSubject: `route:POST /api/cart/checkout:cust:${customerId ?? "guest"}`,
      headers: { "Content-Type": "application/json" },
      auditSink: getAuditSink(),
      log,
    });
    if (!newCart.cart?.id) {
      return {
        rejection: {
          status: 500,
          body: { statusCode: 500, error: "Internal", message: "Não foi possível criar um novo carrinho." },
        },
      };
    }
    cartId = newCart.cart.id;
    await trackCartId(cartId, customerId ? "customer" : "guest");
  }

  // BKL-180 — replace the N per-line `medusa.cart.line_items.add` replay with ONE
  // governed `order.cart.sync` envelope (the pack's bulk-allergen validator + the W5
  // EXECUTE guard adjudicate it once, over the full item set). The cart-replacement
  // edge-handling above (stale/completed/purged → fresh cart) is UNCHANGED — the
  // envelope replaces only the line-item replay leg.
  //
  // RESOLVER-HYDRATION: the web sync body does NOT carry allergens, so the route reads
  // each item's DECLARED allergens from the catalog and STAMPS them into the payload
  // BEFORE adjudication (reading declared data is Hard-Rule-#1-compliant). FAIL-CLOSED:
  // a catalog-read failure or a variant with no declared allergens array → REFUSE-safe
  // (an honest checkout error), NEVER proceed unstamped, NEVER fabricate `[]`.
  const hydratedItems: OrderCartSyncPayload["items"][number][] = [];
  for (const item of localItems) {
    const allergens = await lookupDeclaredAllergensByVariant(item.variantId);
    if (allergens === null) {
      return {
        rejection: {
          status: 422,
          body: {
            statusCode: 422,
            error: "Unprocessable Entity",
            message:
              "Não foi possível confirmar os alérgenos de um item do carrinho. Atualize a página e tente novamente.",
            code: "CART_SYNC_ALLERGENS_UNAVAILABLE",
          },
        },
      };
    }
    hydratedItems.push({ variantId: item.variantId, quantity: item.quantity, allergens });
  }

  const syncEnvelope = buildCustomerEnvelope<"order.cart.sync", OrderCartSyncPayload>({
    kind: "order.cart.sync",
    payload: { cartId, items: hydratedItems },
    nonce: deriveCartNonce(`${cartId}:cart-sync`),
    customerId: customerId ?? `guest:${cartId}`,
  });
  const syncState: OrderState = {
    ctx: {
      channel: "web",
      customerId: customerId ?? null,
      cartId,
      orderId: null,
      paymentMethod: null,
      paymentStatus: null,
      totalInCentavos: 0,
    },
  };
  // WRAPPED-LEGACY EXECUTOR (ruling): on EXECUTE run the EXISTING per-item replay —
  // zero egress-behavior change (keeps `productType`, no new availability rejection).
  const out = await runCustomerIntent({
    envelope: syncEnvelope,
    state: syncState,
    policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
    executor: async () => {
      await addLocalItemsToCart({ cartId, localItems, customerId, log });
      return { synced: true, itemCount: localItems.length };
    },
    ctx: {
      customerId: customerId ?? `guest:${cartId}`,
      route: "cart.sync",
      log,
    },
    auditSink: getAuditSink(),
    refusalMessages: portugueseRefusalMessages,
  });
  if (out.decision.kind !== "EXECUTE" && out.decision.kind !== "REWRITE") {
    // A non-EXECUTE decision (e.g. the bulk-allergen validator REFUSE) aborts the sync
    // leg with the gateway's typed pt-BR body surfaced verbatim (mirrors checkout).
    return { rejection: { status: out.statusCode, body: out.body as Record<string, unknown> } };
  }
  return { cartId };
}

/** Validate checkout composition: kitchen-closed (food blocked), delivery-type
 *  vs payment/cart combinations, and the cash/PIX auth requirement (SEC-001).
 *  Returns the first matching rejection, or null when the checkout may proceed. */
function validateCheckoutComposition(args: {
  mealPeriod: string;
  paymentMethod: PaymentMethod;
  deliveryType: "delivery" | "shipping" | "pickup" | "dine_in" | undefined;
  deliveryCep: string | undefined;
  items: Array<{ productType?: "food" | "frozen" | "merchandise" }> | undefined;
  customerId: string | undefined;
}): CheckoutRejection | null {
  const { mealPeriod, paymentMethod, deliveryType, deliveryCep, customerId } = args;
  const localItems = args.items ?? [];

  // Closed-hours policy (DECIDED): a closed PICKUP food order is ACCEPTED as a
  // *scheduled* pickup (the `scheduledPickup` tag is applied downstream by
  // create-checkout.ts buildCheckoutMetadata); only IMMEDIATE-DELIVERY (local
  // delivery / dine-in) food orders are still REFUSED while closed. Frozen/merch
  // are always allowed. Pickup MUST be distinguished EXACTLY as create-checkout.ts
  // does it: buildCheckoutMetadata keys pickup SOLELY on the ABSENCE of a
  // deliveryCep (`deliveryType = deliveryCep ? "delivery" : "pickup"`; the
  // scheduledPickup tag is applied only when !deliveryCep). So the accepted
  // (scheduled-pickup) set here must be a SUBSET of create-checkout's `!deliveryCep`
  // set — otherwise `closed + food + deliveryType="pickup" + deliveryCep present`
  // would be accepted here yet treated as immediate DELIVERY downstream (the hole).
  // We therefore require NO deliveryCep and an unset/pickup type; explicit
  // delivery / shipping / dine_in remain immediate and are still REFUSED while closed.
  const isScheduledPickup =
    !deliveryCep &&
    deliveryType !== "delivery" &&
    deliveryType !== "shipping" &&
    deliveryType !== "dine_in";
  if (
    mealPeriod === "closed" &&
    !isScheduledPickup &&
    localItems.some((i) => i.productType === "food")
  ) {
    return {
      status: 422,
      body: {
        statusCode: 422,
        error: "Unprocessable Entity",
        message:
          "A cozinha está fechada no momento — não entregamos comida agora. Você pode agendar uma retirada (fechado para retirada agora — posso agendar).",
        code: "KITCHEN_CLOSED",
      },
    };
  }

  if (deliveryType === "shipping") {
    if (localItems.some((i) => i.productType !== "merchandise")) {
      return {
        status: 422,
        body: {
          statusCode: 422,
          error: "Unprocessable Entity",
          message: "Apenas produtos da loja podem ser enviados pelo correio. Itens de comida e congelados precisam de entrega local ou retirada.",
          code: "SHIPPING_NON_MERCHANDISE",
        },
      };
    }
    if (paymentMethod === "cash") {
      return {
        status: 422,
        body: {
          statusCode: 422,
          error: "Unprocessable Entity",
          message: "Pagamento em dinheiro não disponível para envios. Escolha PIX ou cartão.",
          code: "CASH_NOT_ALLOWED_FOR_SHIPPING",
        },
      };
    }
  }

  if (deliveryType === "dine_in" && !localItems.some((i) => i.productType === "food")) {
    return {
      status: 422,
      body: {
        statusCode: 422,
        error: "Unprocessable Entity",
        message: "Comer no restaurante disponível apenas para pedidos com itens de comida.",
        code: "DINEIN_REQUIRES_FOOD",
      },
    };
  }

  // SEC-001: Cash/PIX requires authentication — Stripe validates identity for card payments
  if ((paymentMethod === "cash" || paymentMethod === "pix") && !customerId) {
    return {
      status: 401,
      body: {
        statusCode: 401,
        error: "Unauthorized",
        message: "Autenticação necessária para pagamento em dinheiro/PIX.",
      },
    };
  }

  return null;
}

/** Resolve PIX billing details for checkout: validate any submitted CPF at the
 *  trust boundary (Receita Federal checksum), then merge submitted form fields
 *  over cached values. Returns a rejection on an invalid CPF, or the resolved
 *  billing extra. */
async function resolvePixBillingDetails(args: {
  pixName?: string;
  pixEmail?: string;
  pixCpf?: string;
  customerId: string | undefined;
}): Promise<
  | { rejection: CheckoutRejection }
  | { pixExtra: { customerName?: string; customerEmail?: string; customerTaxId?: string } }
> {
  const { pixName, pixEmail, pixCpf, customerId } = args;

  // P1-DATA-CPF: validate the CPF checksum before it flows to Stripe + Prisma.
  let normalizedFormCpf: string | undefined;
  if (pixCpf !== undefined && pixCpf.trim() !== "") {
    const normalized = normalizeCpf(pixCpf);
    if (!normalized || !isValidCpf(pixCpf)) {
      return {
        rejection: {
          status: 422,
          body: {
            statusCode: 422,
            error: "Unprocessable Entity",
            message: "CPF inválido. Verifique os dígitos e tente novamente. Formato: 000.000.000-00.",
            code: "INVALID_CPF",
          },
        },
      };
    }
    normalizedFormCpf = normalized;
  }

  // Try loading cached PIX details for authenticated customers
  let cached: { name?: string; email?: string; cpf?: string } | null = null;
  if (customerId) {
    cached = await loadCachedPixDetails(customerId);
  }

  return {
    pixExtra: {
      customerName: pixName ?? cached?.name,
      customerEmail: pixEmail ?? cached?.email,
      customerTaxId: normalizedFormCpf ?? cached?.cpf,
    },
  };
}

/** Build the `order.checkout.create` kernel payload, attaching PIX billing
 *  details only for PIX checkouts. */
function buildCheckoutPayload(
  cartId: string,
  paymentMethod: PaymentMethod,
  pixExtra: { customerName?: string; customerEmail?: string; customerTaxId?: string } | undefined,
): OrderCheckoutCreatePayload {
  return {
    cartId,
    paymentMethod,
    ...(paymentMethod === "pix" && pixExtra
      ? {
          pixDetails: {
            name: pixExtra.customerName ?? "",
            email: pixExtra.customerEmail ?? "",
            cpf: pixExtra.customerTaxId ?? "",
          },
        }
      : {}),
  };
}

/** Build the orders ctx for checkout from the REAL cart via the shared
 *  resolve-and-assemble builder, threading the request's deliveryType onto
 *  ctx.fulfillment (T1a-13: the pack's requireSlotsFilledForCheckout guard
 *  requires a non-null fulfillment). */
async function buildCheckoutOrderState(args: {
  guestKey: string;
  paymentMethod: PaymentMethod;
  deliveryType: string | undefined;
  cartId: string;
}): Promise<OrderState> {
  const { guestKey, paymentMethod, deliveryType, cartId } = args;
  return {
    ctx: await loadCartCtx(
      identityCtx(guestKey, "web"),
      {
        paymentMethod,
        ...(deliveryType === undefined ? {} : { deliveryType }),
      } as Record<string, unknown>,
      { cartId },
    ),
  } as unknown as OrderState;
}

/** Map the adjudicated checkout decision onto the HTTP response: park a
 *  large-ticket REQUEST_CONFIRMATION (202 + receipt), surface any other
 *  non-EXECUTE/REWRITE decision verbatim, or finalize the money-path side
 *  effects on EXECUTE/REWRITE. Shared so the checkout paths never drift. */
async function respondToCheckoutDecision(args: {
  reply: FastifyReply;
  out: Awaited<ReturnType<typeof runCustomerIntent>>;
  checkoutPayload: OrderCheckoutCreatePayload;
  checkoutIdempotencyKey: string;
  cartId: string;
  sessionId: string;
  paymentMethod: PaymentMethod;
  customerId: string | undefined;
  userType: UserType;
  checkoutBody: Record<string, unknown>;
  pixExtra: { customerName?: string; customerEmail?: string; customerTaxId?: string } | undefined;
  notes: string | undefined;
  releaseGate: () => Promise<void>;
}): Promise<FastifyReply> {
  const {
    reply, out, checkoutPayload, checkoutIdempotencyKey, cartId, sessionId,
    paymentMethod, customerId, userType, checkoutBody, pixExtra, notes, releaseGate,
  } = args;

  // REQUEST_CONFIRMATION (large-ticket ≥ R$1.000) — park the prepared checkout
  // under a single-use receipt and enrich the 202 with the confirmationId.
  if (out.decision.kind === "REQUEST_CONFIRMATION") {
    const prompt = out.decision.prompt;
    const parked = await checkoutConfirmationStore.create({
      kind: "order.checkout.create",
      payload: checkoutPayload,
      idempotencyKey: checkoutIdempotencyKey,
      cartId,
      customerId: sessionId,
      userType,
      checkoutBody,
      ...(pixExtra ? { pixExtra } : {}),
      prompt,
      createdAt: new Date().toISOString(),
    });
    return reply.code(202).send({
      confirmationRequired: true,
      confirmationId: parked.confirmationId,
      prompt,
      ttlSeconds: parked.ttlSeconds,
    });
  }

  // Other non-EXECUTE/REWRITE branches (REFUSE 403 / DEFER 202 / ESCALATE 503)
  // — surface the gateway's reply verbatim.
  if (out.decision.kind !== "EXECUTE" && out.decision.kind !== "REWRITE") {
    return reply.code(out.statusCode).send(out.body);
  }

  // EXECUTE / REWRITE: apply post-checkout side effects + respond.
  const result = out.body as Awaited<ReturnType<typeof createCheckout>>;
  return finalizeCheckout({
    reply,
    result,
    cartId,
    paymentMethod,
    customerId,
    ...(pixExtra ? { pixExtra } : {}),
    ...(notes ? { notes } : {}),
    onFixableFailure: releaseGate,
  });
}

/** Resolve a caller-supplied order id (Stripe `pi_`, display `IBX-<n>`, or raw
 *  Medusa id) to a Medusa order for the order-read endpoint, or a 202-pending
 *  body when the order does not exist yet. */
async function resolveOrderForRead(orderId: string): Promise<ResolvedOrderRead> {
  if (orderId.startsWith("pi_")) {
    // PIX/card: orderId is a Stripe PaymentIntent ID — order may not exist yet
    // (created only after Stripe webhook fires). Search by metadata.
    let order: MedusaOrder | undefined;
    try {
      const searchData = await medusaAdmin(`/admin/orders?metadata[stripePaymentIntentId]=${encodeURIComponent(orderId)}&limit=1`) as {
        orders?: MedusaOrder[];
      };
      order = searchData.orders?.[0];
    } catch {
      // Order not found via metadata — may not exist yet
    }
    if (!order) {
      // Order hasn't been created yet (webhook hasn't fired)
      return {
        kind: "pending",
        body: {
          status: "pending",
          paymentIntentId: orderId,
          message: "Aguardando confirmação do pagamento. O pedido será criado automaticamente após a confirmação.",
        },
      };
    }
    return { kind: "order", order };
  }

  if (/^IBX-\d+$/i.test(orderId)) {
    // Display ID format (e.g. "IBX-0004") — resolve to Medusa order via OrderProjection
    return resolveDisplayIdOrder(orderId);
  }

  const data = await medusaAdmin(`/admin/orders/${orderId}`) as { order?: MedusaOrder };
  return { kind: "order", order: data.order };
}

/** Resolve an `IBX-<n>` display id to a Medusa order via the OrderProjection,
 *  falling back to a Medusa display_id query (NATS subscriber lag), or a
 *  202-pending body when still unresolved. */
async function resolveDisplayIdOrder(orderId: string): Promise<ResolvedOrderRead> {
  const displayId = Number.parseInt(orderId.replace(/^IBX-/i, ""), 10);
  const projection = await prisma.orderProjection.findFirst({
    where: { displayId },
    select: { id: true },
  });
  if (projection) {
    const data = await medusaAdmin(`/admin/orders/${projection.id}`) as { order?: MedusaOrder };
    return { kind: "order", order: data.order };
  }
  // Fallback: projection not created yet (NATS subscriber lag) — query Medusa by display_id
  let order: MedusaOrder | undefined;
  try {
    const searchData = await medusaAdmin(
      `/admin/orders?display_id=${displayId}&limit=1`,
    ) as { orders?: MedusaOrder[] };
    order = searchData.orders?.[0];
  } catch {
    // Medusa query failed
  }
  if (!order) {
    return {
      kind: "pending",
      body: {
        status: "pending",
        message: "Aguardando confirmação do pedido...",
      },
    };
  }
  return { kind: "order", order };
}

/** Resolve an `IBX-<n>` display id to a Medusa order id for the status-poll
 *  endpoint (projection first, Medusa display_id query as backfill grace).
 *  Returns the input unchanged for non-display ids or when unresolved. */
async function resolveStatusOrderId(orderId: string): Promise<string> {
  if (!/^IBX-\d+$/i.test(orderId)) return orderId;
  const displayId = Number.parseInt(orderId.replace(/^IBX-/i, ""), 10);
  const proj = await prisma.orderProjection.findFirst({
    where: { displayId },
    select: { id: true },
  });
  if (proj) return proj.id;
  // Fallback: projection not created yet (NATS subscriber lag) — query Medusa by display_id
  try {
    const searchData = await medusaAdmin(
      `/admin/orders?display_id=${displayId}&limit=1&fields=id`,
    ) as { orders?: Array<{ id: string }> };
    if (searchData.orders?.[0]?.id) {
      return searchData.orders[0].id;
    }
  } catch {
    // Will fall through to existing 202 handling
  }
  return orderId;
}

/** Compute the order-status poll outcome (projection-first, Medusa fallback),
 *  enforcing the R0a deny-null-owner IDOR guard on both paths. */
async function computeOrderStatus(args: {
  orderId: string;
  orderIdParam: string;
  accessToken: string | undefined;
  customerId: string | undefined;
  log: RouteLog;
}): Promise<StatusReadOutcome> {
  const { orderId, orderIdParam, accessToken, customerId, log } = args;
  try {
    // Primary: read from projection
    const { createOrderQueryService: createQS } = await import("@ibatexas/domain");
    const querySvc = createQS();
    const projection = await querySvc.getById(orderId);

    if (projection) {
      // R0a — deny-null-owner IDOR guard (SDD Inv 2/13).
      if (!isOrderReadAuthorized({
        orderCustomerId: projection.customerId,
        requestCustomerId: customerId,
        orderIdParam,
        accessToken,
      })) {
        return { status: 404, body: { error: "Pedido não encontrado." }, noStore: false };
      }
      const pqs = createPaymentQueryService();
      const cp = await pqs.getActiveByOrderId(orderId).catch(() => null);
      return {
        status: 200,
        noStore: true,
        body: {
          status: projection.fulfillmentStatus,
          paymentStatus: cp ? cp.status : null,
          updatedAt: projection.updatedAt?.toISOString() ?? null,
          source: "projection",
        },
      };
    }

    // Fallback: projection not found — use Medusa (backfill grace + pi_ lookup)
    log.warn({ orderId }, "projection_fallback_used — order status poll");
    let order: { fulfillment_status?: string; status?: string; updated_at?: string; customer_id?: string; metadata?: Record<string, string> } | undefined;

    if (orderId.startsWith("pi_")) {
      const searchData = await medusaAdmin(`/admin/orders?metadata[stripePaymentIntentId]=${encodeURIComponent(orderId)}&limit=1&fields=fulfillment_status,status,updated_at,customer_id,metadata`) as {
        orders?: Array<typeof order>;
      };
      order = searchData.orders?.[0];
    } else {
      const data = await medusaAdmin(`/admin/orders/${orderId}?fields=fulfillment_status,status,updated_at,customer_id,metadata`) as {
        order?: NonNullable<typeof order>;
      };
      order = data.order;
    }

    if (!order) {
      return { status: 202, body: { status: "pending", updatedAt: null }, noStore: false };
    }

    // R0a — deny-null-owner IDOR guard (SDD Inv 2/13), Medusa-fallback path.
    const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
    if (!isOrderReadAuthorized({
      orderCustomerId,
      requestCustomerId: customerId,
      orderIdParam,
      accessToken,
    })) {
      return { status: 404, body: { error: "Pedido não encontrado." }, noStore: false };
    }

    // Medusa uses "not_fulfilled" / "fulfilled" / "canceled" etc. Normalize to
    // our domain vocabulary so the frontend stays consistent.
    const rawStatus = order.fulfillment_status ?? order.status ?? "pending";
    const MEDUSA_STATUS_MAP: Record<string, string> = {
      not_fulfilled: "pending",
      fulfilled: "delivered",
      partially_fulfilled: "preparing",
      returned: "canceled",
      requires_action: "pending",
    };
    const normalizedStatus = MEDUSA_STATUS_MAP[rawStatus] ?? rawStatus;

    return {
      status: 200,
      noStore: true,
      body: {
        status: normalizedStatus,
        updatedAt: order.updated_at ?? null,
        source: "medusa_fallback",
      },
    };
  } catch (err) {
    log.error(err, "Failed to fetch order status");
    return { status: 502, body: { error: "Failed to fetch order status" }, noStore: false };
  }
}

export async function cartRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // POST /api/cart — create cart
  app.post(
    "/api/cart",
    {
      schema: { tags: ["cart"], summary: "Criar carrinho" },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // If authenticated, resolve the customer's Medusa ID so the resulting
      // order is linked to the customer and appears in /account/orders.
      let cartBody: Record<string, unknown> = {};
      if (request.customerId) {
        try {
          const customerSvc = createCustomerService();
          const customer = await customerSvc.getById(request.customerId);
          if (customer.medusaId) {
            cartBody = { customer_id: customer.medusaId };
          }
        } catch {
          // Customer lookup failed — create cart without binding (guest mode)
        }
      }

      try {
        const data = await medusaAdjudicated<Record<string, unknown>, unknown>({
          scope: "store",
          method: "POST",
          path: "/store/carts",
          payload: cartBody,
          intentKind: "medusa.cart.create",
          idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? randomUUID(),
          sourceSubject: `route:POST /api/cart:cust:${request.customerId ?? "guest"}`,
          headers: { "Content-Type": "application/json" },
          auditSink: getAuditSink(),
          log: server.log,
        });

        const cartId = (data as { cart?: { id: string } }).cart?.id;
        if (cartId) await trackCartId(cartId, request.customerId ? "customer" : "guest");

        return reply.code(201).send(data);
      } catch (err) {
        if (mapMedusaErrorToReply(err, reply)) return reply;
        throw err;
      }
    },
  );

  // GET /api/cart/:id — get cart
  app.get(
    "/api/cart/:id",
    {
      schema: { tags: ["cart"], summary: "Buscar carrinho", params: CartIdParams },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const data = await medusaStore(`/store/carts/${request.params.id}`);
      return reply.send(data);
    },
  );

  // POST /api/cart/:id/line-items — add item
  app.post(
    "/api/cart/:id/line-items",
    {
      schema: {
        tags: ["cart"],
        summary: "Adicionar item ao carrinho",
        params: CartIdParams,
        body: z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(99) }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // SEC: Verify cart ownership before mutation
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      // Ensure cart is tracked for abandoned-cart detection
      await trackCartId(request.params.id, request.customerId ? "customer" : "guest");

      try {
        const data = await medusaAdjudicated<typeof request.body, unknown>({
          scope: "store",
          method: "POST",
          path: `/store/carts/${request.params.id}/line-items`,
          payload: request.body,
          intentKind: "medusa.cart.line_items.add",
          idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? randomUUID(),
          sourceSubject: `route:POST /api/cart/:id/line-items:cust:${request.customerId ?? "guest"}`,
          headers: { "Content-Type": "application/json" },
          auditSink: getAuditSink(),
          log: server.log,
        });
        return reply.code(201).send(data);
      } catch (err) {
        if (mapMedusaErrorToReply(err, reply)) return reply;
        throw err;
      }
    },
  );

  // PATCH /api/cart/:id/line-items/:itemId — update quantity
  app.patch(
    "/api/cart/:id/line-items/:itemId",
    {
      schema: {
        tags: ["cart"],
        summary: "Atualizar quantidade do item",
        params: CartItemParams,
        body: z.object({ quantity: z.number().int().min(1).max(99) }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // SEC: Verify cart ownership before mutation
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      try {
        const data = await medusaAdjudicated<typeof request.body, unknown>({
          scope: "store",
          method: "POST",
          path: `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
          payload: request.body,
          intentKind: "medusa.cart.line_items.update",
          idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? randomUUID(),
          sourceSubject: `route:PATCH /api/cart/:id/line-items/:itemId:cust:${request.customerId ?? "guest"}`,
          headers: { "Content-Type": "application/json" },
          auditSink: getAuditSink(),
          log: server.log,
        });
        return reply.send(data);
      } catch (err) {
        if (mapMedusaErrorToReply(err, reply)) return reply;
        throw err;
      }
    },
  );

  // DELETE /api/cart/:id/line-items/:itemId — remove item
  app.delete(
    "/api/cart/:id/line-items/:itemId",
    {
      schema: {
        tags: ["cart"],
        summary: "Remover item do carrinho",
        params: CartItemParams,
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // SEC: Verify cart ownership before mutation
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      try {
        const data = await medusaAdjudicated<undefined, unknown>({
          scope: "store",
          method: "DELETE",
          path: `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
          intentKind: "medusa.cart.line_items.remove",
          idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? randomUUID(),
          sourceSubject: `route:DELETE /api/cart/:id/line-items/:itemId:cust:${request.customerId ?? "guest"}`,
          auditSink: getAuditSink(),
          log: server.log,
        });
        return reply.send(data);
      } catch (err) {
        if (mapMedusaErrorToReply(err, reply)) return reply;
        throw err;
      }
    },
  );

  // POST /api/cart/:id/promotions — apply coupon
  app.post(
    "/api/cart/:id/promotions",
    {
      schema: {
        tags: ["cart"],
        summary: "Aplicar código de desconto",
        params: CartIdParams,
        body: z.object({ promo_codes: z.array(z.string()) }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      try {
        const data = await medusaAdjudicated<typeof request.body, unknown>({
          scope: "store",
          method: "POST",
          path: `/store/carts/${request.params.id}/promotions`,
          payload: request.body,
          intentKind: "medusa.cart.promotion.apply",
          idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? randomUUID(),
          sourceSubject: `route:POST /api/cart/:id/promotions:cust:${request.customerId ?? "guest"}`,
          headers: { "Content-Type": "application/json" },
          auditSink: getAuditSink(),
          log: server.log,
        });
        return reply.send(data);
      } catch (err) {
        if (mapMedusaErrorToReply(err, reply)) return reply;
        throw err;
      }
    },
  );

  // POST /api/cart/:id/payment-sessions — initialize payment (Medusa v2 flow)
  app.post(
    "/api/cart/:id/payment-sessions",
    {
      schema: {
        tags: ["cart"],
        summary: "Inicializar sessão de pagamento",
        params: CartIdParams,
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      try {
        // Medusa v2: payment sessions live on payment collections, not carts.
        // The cart GET stays on bare medusaStore (reads are not governed).
        const cartData = await medusaStore(`/store/carts/${request.params.id}`) as {
          cart?: { payment_collection?: { id: string } };
        };
        let pcId = cartData.cart?.payment_collection?.id;
        const subject = `route:POST /api/cart/:id/payment-sessions:cust:${request.customerId ?? "guest"}`;
        if (!pcId) {
          const pcData = await medusaAdjudicated<{ cart_id: string }, { payment_collection?: { id: string } }>({
            scope: "store",
            method: "POST",
            path: "/store/payment-collections",
            payload: { cart_id: request.params.id },
            intentKind: "medusa.payment_collection.create",
            idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? `pc:${request.params.id}:${randomUUID()}`,
            sourceSubject: subject,
            headers: { "Content-Type": "application/json" },
            auditSink: getAuditSink(),
            log: server.log,
          });
          pcId = pcData.payment_collection?.id;
        }
        if (!pcId) {
          return reply.status(500).send({ error: "Failed to create payment collection" });
        }
        const body = (request.body as { provider_id?: string }) ?? {};
        const data = await medusaAdjudicated<typeof body, unknown>({
          scope: "store",
          method: "POST",
          path: `/store/payment-collections/${pcId}/payment-sessions`,
          payload: body,
          intentKind: "medusa.payment_session.create",
          idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? `ps:${pcId}:${randomUUID()}`,
          sourceSubject: subject,
          headers: { "Content-Type": "application/json" },
          auditSink: getAuditSink(),
          log: server.log,
        });
        return reply.send(data);
      } catch (err) {
        if (mapMedusaErrorToReply(err, reply)) return reply;
        throw err;
      }
    },
  );

  // POST /api/cart/checkout — complete checkout (PIX/card/cash)
  app.post(
    "/api/cart/checkout",
    {
      schema: {
        tags: ["cart"],
        summary: "Finalizar checkout",
        body: z.object({
          cartId: z.string().min(1),
          paymentMethod: z.enum(["pix", "card", "cash"]),
          deliveryType: z.enum(["delivery", "shipping", "pickup", "dine_in"]).optional(),
          tipInCentavos: z.number().int().min(0).optional(),
          deliveryCep: z.string().optional(),
          items: z.array(z.object({
            variantId: z.string().min(1),
            quantity: z.number().int().min(1).max(99),
            productType: z.enum(["food", "frozen", "merchandise"]).optional(),
          })).optional(),
          pixName: z.string().optional(),
          pixEmail: z.email().optional(),
          pixCpf: z.string().optional(),
          notes: z.string().max(500).optional(),
          couponCode: z.string().min(1).max(64).optional(),
        }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // SEC: Verify cart ownership before checkout
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.body.cartId, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      // Block food orders when restaurant is closed; validate delivery-type vs
      // payment/cart combinations; enforce the cash/PIX auth requirement.
      const schedule = await loadSchedule();
      const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
      const mealPeriod = getMealPeriodFromSchedule(schedule, tz);
      const { paymentMethod, deliveryType: reqDeliveryType, deliveryCep: reqDeliveryCep, items: localItems } = request.body;

      const compositionRejection = validateCheckoutComposition({
        mealPeriod,
        paymentMethod,
        deliveryType: reqDeliveryType,
        deliveryCep: reqDeliveryCep,
        items: localItems,
        customerId: request.customerId,
      });
      if (compositionRejection) {
        return reply.status(compositionRejection.status).send(compositionRejection.body);
      }

      // P0-PAY-3 (audit-2026-05-27) — checkout-endpoint dedup. Defense-in-depth
      // on top of Stripe idempotencyKeys + Medusa per-hop keys + the kernel
      // deterministic-nonce ledger: a SET-NX gate rejects a double-submit /
      // network retry with 409 BEFORE any payment or Medusa cart side-effect.
      // Prefer the client Idempotency-Key; fall back to cartId so a rapid
      // double-submit from a client that sends none is still deduped.
      const idemHeader = request.headers["idempotency-key"];
      const idemToken =
        typeof idemHeader === "string" && idemHeader.trim()
          ? idemHeader.trim()
          : request.body.cartId;
      const checkoutGateKey = rk(`checkout:idem:${idemToken}`);
      if (!(await redis.set(checkoutGateKey, "1", { NX: true, EX: 120 }))) {
        return reply.status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "Este checkout já está sendo processado. Aguarde alguns instantes.",
          code: "CHECKOUT_IN_PROGRESS",
        });
      }

      // Sync local cart items to Medusa if provided (web app keeps items in local state)
      let cartId = request.body.cartId;

      if (localItems && localItems.length > 0) {
        const syncResult = await syncLocalCartForCheckout({
          cartId,
          localItems,
          customerId: request.customerId,
          log: server.log,
        });
        if ("rejection" in syncResult) {
          return reply.status(syncResult.rejection.status).send(syncResult.rejection.body);
        }
        cartId = syncResult.cartId;
      }

      // Resolve PIX billing details: form fields override cached data
      let pixExtra: { customerName?: string; customerEmail?: string; customerTaxId?: string } | undefined;
      if (paymentMethod === "pix") {
        const pixResult = await resolvePixBillingDetails({
          pixName: request.body.pixName,
          pixEmail: request.body.pixEmail,
          pixCpf: request.body.pixCpf,
          customerId: request.customerId,
        });
        if ("rejection" in pixResult) {
          return reply.status(pixResult.rejection.status).send(pixResult.rejection.body);
        }
        pixExtra = pixResult.pixExtra;
      }

      // ── Task 14 — wrap checkout in adjudicate envelope ────────────────
      //
      // The kernel may EXECUTE / REWRITE / REFUSE / DEFER (PIX pending) /
      // REQUEST_CONFIRMATION (large-ticket) / ESCALATE here. For guest carts
      // (no customerId), `sessionId` falls back to the cartId so anonymous
      // flows still have a stable key for audit + park bookkeeping.
      const checkoutPayload = buildCheckoutPayload(cartId, paymentMethod, pixExtra);

      const sessionId = request.customerId ?? cartId;
      // ── P0-7 (audit-2026-05-24) — deterministic idempotency-key ─────────
      // Prefer the client's `Idempotency-Key` header; fall back to
      // `${cartId}:checkout` (a cart is logically checked out once).
      const checkoutIdempotencyKey = resolveCartIdempotencyKey(
        request.headers["idempotency-key"],
        `${cartId}:checkout`,
      );
      const envelope = buildCustomerEnvelope<"order.checkout.create", OrderCheckoutCreatePayload>({
        kind: "order.checkout.create",
        payload: checkoutPayload,
        nonce: deriveCartNonce(checkoutIdempotencyKey),
        customerId: sessionId,
      });

      // Unified state contract (Phase 2): build the orders ctx from the REAL cart
      // via the shared resolve-and-assemble builder, so the web checkout
      // adjudicates against the same ctx the conductor uses.
      // ⚠️ BEHAVIOR (ratified): the large-ticket guards apply at web checkout —
      // confirmLargeTicket (≥ R$1.000) → REQUEST_CONFIRMATION (HTTP 202) and
      // refuseAmountAboveCap (≥ R$10.000) → REFUSE (403). The web frontend MUST
      // handle the 202 confirmation reply, or orders ≥ R$1.000 will not complete.
      const guestKey = request.customerId ?? `guest:${cartId}`;
      const orderState = await buildCheckoutOrderState({
        guestKey,
        paymentMethod,
        deliveryType: reqDeliveryType,
        cartId,
      });

      const out = await runCustomerIntent({
        envelope,
        state: orderState,
        policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          // EXECUTE / REWRITE → call the existing checkout tool function.
          // (For REWRITE the kernel substitutes a sanitized payload — by
          // contract the shape is preserved so we still forward the
          // original `request.body` extras like deliveryType / notes.)
          return createCheckout({ ...request.body, cartId }, {
            channel: Channel.Web,
            sessionId: cartId,
            customerId: request.customerId,
            userType: request.userType ?? "guest",
          }, pixExtra);
        },
        ctx: {
          customerId: sessionId,
          route: "cart.checkout",
          log: server.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });

      return respondToCheckoutDecision({
        reply,
        out,
        checkoutPayload,
        checkoutIdempotencyKey,
        cartId,
        sessionId,
        paymentMethod,
        customerId: request.customerId,
        userType: request.userType ?? "guest",
        checkoutBody: request.body as Record<string, unknown>,
        pixExtra,
        notes: request.body.notes,
        releaseGate: async () => {
          // P0-PAY-3 — fixable failure: release the idempotency gate so the
          // customer can correct + retry immediately rather than waiting out
          // the 120s TTL.
          await redis.del(checkoutGateKey);
        },
      });
    },
  );

  // ── POST /api/cart/checkout/confirm ─────────────────────────────────────
  //
  // Resume a parked large-ticket checkout (the REQUEST_CONFIRMATION reply
  // from POST /api/cart/checkout). The single-use receipt is consumed, the
  // cart state is re-loaded FRESH, and the IDENTICAL envelope is rebuilt and
  // re-adjudicated through the AUDITED kernel verb carrying a
  // confirmationReceipt — so the kernel substitutes EXECUTE for the matching
  // intentHash while still enforcing every state/taint/auth guard. A cart
  // that crossed the hard REFUSE cap (≥ R$10.000) since the request is still
  // refused here (403).
  app.post(
    "/api/cart/checkout/confirm",
    {
      schema: {
        tags: ["cart"],
        summary: "Confirmar checkout de alto valor",
        body: z.object({
          confirmationId: z.string().min(1).max(64),
        }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const redis = await getRedisClient();

      // Single-use consume — unknown / expired / already-confirmed → 410 Gone.
      const pending = await checkoutConfirmationStore.consume(
        request.body.confirmationId,
      );
      if (!pending) {
        return reply.status(410).send({
          statusCode: 410,
          error: "Gone",
          message:
            "Esta confirmação expirou ou já foi utilizada. Refaça o checkout.",
          code: "CONFIRMATION_EXPIRED",
        });
      }

      // ── Money-safety ownership ───────────────────────────────────────────
      // The envelope actor sessionId at park time was
      // `request.customerId ?? cartId`. Recompute the same key for the
      // confirming session and require equality — a different logged-in
      // customer (or a guest holding a leaked receipt) cannot confirm
      // someone else's order.
      const confirmSessionId = request.customerId ?? pending.cartId;
      if (pending.customerId !== confirmSessionId) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Esta confirmação pertence a outro usuário.",
        });
      }

      // Cart-ownership parity with the checkout route (defense-in-depth).
      if (!(await verifyCartOwnership(pending.cartId, request.customerId, redis))) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Carrinho pertence a outro usuário.",
        });
      }

      // Re-load cart state FRESH so a since-changed total re-adjudicates. The
      // confirmationReceipt only satisfies the "ask first" threshold — a cart
      // that grew past the hard cap (≥ R$10.000) is still REFUSEd below.
      //
      // T2-2b fix (JOURNEY-016 live finding — same class as the T1a-13
      // checkout-route fix): the resume ctx MUST carry the parked request's
      // deliveryType — buildCartCtx maps it onto ctx.fulfillment, which the
      // pack's requireSlotsFilledForCheckout guard requires non-null.
      // Without it the confirm leg 403'd `order.checkout.slots_incomplete`
      // for EVERY large-ticket order: the 202 parked fine and the resume
      // could never complete — no ≥R$1.000 web order was completable at
      // all. The original checkout body is stored on the parked receipt
      // (checkoutBody), so the resume re-adjudicates the same fulfillment
      // the customer chose.
      const pendingDeliveryType = pending.checkoutBody["deliveryType"];
      const guestKey = request.customerId ?? `guest:${pending.cartId}`;
      const orderState = {
        ctx: await loadCartCtx(
          identityCtx(guestKey, "web"),
          {
            paymentMethod: pending.payload.paymentMethod,
            ...(typeof pendingDeliveryType === "string"
              ? { deliveryType: pendingDeliveryType }
              : {}),
          } as Record<string, unknown>,
          { cartId: pending.cartId },
        ),
      } as unknown as OrderState;

      // Rebuild the IDENTICAL envelope — same kind/payload/nonce/actor → same
      // intentHash (schema v2: createdAt is NOT hashed) — so the receipt
      // matches and the kernel can resolve the confirmation.
      const envelope = buildCustomerEnvelope<"order.checkout.create", OrderCheckoutCreatePayload>({
        kind: "order.checkout.create",
        payload: pending.payload,
        nonce: deriveCartNonce(pending.idempotencyKey),
        customerId: pending.customerId,
      });

      const out = await runCustomerIntent({
        envelope,
        state: orderState,
        policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          return createCheckout(
            { ...pending.checkoutBody, cartId: pending.cartId } as Parameters<typeof createCheckout>[0],
            {
              channel: Channel.Web,
              sessionId: pending.cartId,
              customerId: request.customerId,
              userType: pending.userType,
            },
            pending.pixExtra,
          );
        },
        ctx: {
          customerId: pending.customerId,
          route: "cart.checkout.confirm",
          log: server.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
        confirmationReceipt: {
          intentHash: envelope.intentHash,
          at: new Date().toISOString(),
          token: request.body.confirmationId,
        },
      });

      // Non-EXECUTE/REWRITE (incl. a now-≥R$10k REFUSE → 403) — surface verbatim.
      if (out.decision.kind !== "EXECUTE" && out.decision.kind !== "REWRITE") {
        return reply.code(out.statusCode).send(out.body);
      }

      const result = out.body as Awaited<ReturnType<typeof createCheckout>>;
      return finalizeCheckout({
        reply,
        result,
        cartId: pending.cartId,
        paymentMethod: pending.payload.paymentMethod,
        customerId: request.customerId,
        ...(pending.pixExtra ? { pixExtra: pending.pixExtra } : {}),
        ...(typeof pending.checkoutBody.notes === "string"
          ? { notes: pending.checkoutBody.notes }
          : {}),
      });
    },
  );

  // GET /api/cart/pix-details — load cached PIX billing details for authenticated customer
  app.get(
    "/api/cart/pix-details",
    {
      schema: {
        tags: ["cart"],
        summary: "Buscar dados PIX salvos do cliente",
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const cached = await loadCachedPixDetails(request.customerId!);
      if (cached) {
        // Return full CPF — this is the customer's own data behind requireAuth,
        // and the checkout form needs the real value for Stripe PIX validation.
        return reply.send(cached);
      }
      return reply.send({});
    },
  );

  // GET /api/cart/delivery-estimate — delivery fee by CEP
  app.get(
    "/api/cart/delivery-estimate",
    {
      schema: {
        tags: ["cart"],
        summary: "Estimar taxa de entrega por CEP",
        querystring: z.object({ cep: z.string().min(8).max(9) }),
      },
    },
    async (request, reply) => {
      const result = await estimateDelivery({ cep: request.query.cep });
      if (!result.success) {
        return reply.status(400).send(result);
      }
      return reply.send(result);
    },
  );

  // GET /api/cart/orders/:orderId — order details (with ownership verification)
  app.get(
    "/api/cart/orders/:orderId",
    {
      schema: {
        tags: ["cart"],
        summary: "Buscar detalhes do pedido",
        params: z.object({ orderId: z.string().min(1) }),
        // R0a — optional signed per-order access token for guest reads, supplied
        // via the `X-Order-Access-Token` header (never a query param — CWE-598:
        // tokens in URLs land in access logs / Referer).
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const { orderId } = request.params;
      const resolved = await resolveOrderForRead(orderId);
      if (resolved.kind === "pending") {
        return reply.status(202).send(resolved.body);
      }
      const order = resolved.order;

      if (!order) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Pedido não encontrado." });
      }

      // R0a — deny-null-owner IDOR guard (SDD Inv 2/13). Authorize iff the
      // authenticated caller owns the order OR a valid signed per-order token
      // bound to this :orderId is presented. A null `customer_id` (guest order)
      // no longer short-circuits to ALLOW: "no owner" ≠ "any owner". Order
      // display IDs (IBX-<n>) are sequential + enumerable, so unauthorized
      // reads must 404.
      const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
      if (!isOrderReadAuthorized({
        orderCustomerId,
        requestCustomerId: request.customerId,
        orderIdParam: orderId,
        accessToken: request.headers["x-order-access-token"] as string | undefined,
      })) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Pedido não encontrado." });
      }

      // Medusa v2 returns prices in reais — convert to centavos for frontend
      const pqs = createPaymentQueryService();
      const cp = await pqs.getActiveByOrderId(order.id).catch(() => null);

      const orderResponse = {
        ...order,
        total: reaisToCentavos(order.total),
        subtotal: reaisToCentavos(order.subtotal),
        shipping_total: reaisToCentavos(order.shipping_total),
        delivery_type: order.metadata?.["deliveryType"] ?? null,
        payment_method: cp ? cp.method : (order.metadata?.["paymentMethod"] ?? null),
        payment_status: cp ? cp.status : null,
        tip_in_centavos: Number(order.metadata?.["tipInCentavos"]) || 0,
        items: order.items.map((i) => ({
          ...i,
          unit_price: reaisToCentavos(i.unit_price),
          variant_id: i.variant_id ?? undefined,
          productType: (i.metadata?.productType as "food" | "frozen" | "merchandise") ?? undefined,
        })),
        currentPayment: cp ? {
          id: cp.id,
          method: cp.method,
          status: cp.status,
          amountInCentavos: cp.amountInCentavos,
          pixExpiresAt: cp.pixExpiresAt?.toISOString() ?? null,
          version: cp.version,
        } : null,
      };
      return reply.send({ order: orderResponse });
    },
  );

  // GET /api/cart/orders/:orderId/status — lightweight polling for order status
  app.get(
    "/api/cart/orders/:orderId/status",
    {
      schema: {
        tags: ["cart"],
        summary: "Status do pedido (polling)",
        params: z.object({ orderId: z.string().min(1) }),
        // R0a — optional signed per-order access token for guest polls, supplied
        // via the `X-Order-Access-Token` header (never a query param — CWE-598:
        // tokens in URLs land in access logs / Referer).
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // R0a — capture the caller-supplied id BEFORE the IBX-/pi_ → Medusa-id
      // resolution: the per-order token is bound to the exact id the client
      // holds (== the /pedido/<id> route param), not the resolved id.
      const orderIdParam = request.params.orderId;
      const accessToken = request.headers["x-order-access-token"] as string | undefined;
      const orderId = await resolveStatusOrderId(orderIdParam);

      const outcome = await computeOrderStatus({
        orderId,
        orderIdParam,
        accessToken,
        customerId: request.customerId,
        log: server.log,
      });
      if (outcome.noStore) {
        reply.header("Cache-Control", "no-store");
      }
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  // POST /api/coupons/validate — validate coupon code
  app.post(
    "/api/coupons/validate",
    {
      schema: {
        tags: ["cart"],
        summary: "Validar código de cupom",
        body: z.object({ code: z.string().min(1) }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // BKL-070 — display-parity validation. Mirrors the REJECTION CLASSES the
      // checkout's authoritative Medusa promotions.add gate enforces (D1 fail-closed
      // 422 COUPON_REJECTED), so the UI rarely shows a discount that later dies at
      // checkout. The default admin promotion fields already include status, limit,
      // used, *campaign, *campaign.budget and *application_method (Medusa
      // api/admin/promotions/query-config defaultAdminPromotionFields) — one GET,
      // no fields= param. NOTE the old `is_disabled` check was DEAD in Medusa v2
      // (no such field; `status` is the real flag) — it passed vacuously.
      //
      // Deliberately NOT mirrored (only Medusa's engine can evaluate them; the
      // checkout 422 stays authoritative): target/buy rules, stackability, and the
      // per-attribute budget types (use_by_attribute / spend_by_attribute — those
      // need the customer attribute and MUST NOT over-reject here).
      try {
        const data = await medusaAdmin(`/admin/promotions?code=${encodeURIComponent(request.body.code)}&limit=1`) as {
          promotions?: Array<{
            id: string;
            code: string;
            status?: "draft" | "active" | "inactive";
            limit?: number | null;
            used?: number;
            campaign?: {
              starts_at?: string | null;
              ends_at?: string | null;
              budget?: {
                type?: "spend" | "usage" | "use_by_attribute" | "spend_by_attribute";
                limit?: number | null;
                used?: number;
              } | null;
            } | null;
            application_method?: {
              value?: number;
              type?: string;
            };
          }>;
        };

        const promo = data.promotions?.[0];
        if (!promo) return reply.send({ valid: false });

        // status: the v2 lifecycle flag. Absent (unexpected) ⇒ treat as not active
        // (display-side fail-closed: never show a discount we cannot substantiate).
        if (promo.status !== "active") return reply.send({ valid: false });

        // Campaign window (only when bounds are present — absent bound ⇒ no bound).
        const now = Date.now();
        const startsAt = promo.campaign?.starts_at ? Date.parse(promo.campaign.starts_at) : undefined;
        const endsAt = promo.campaign?.ends_at ? Date.parse(promo.campaign.ends_at) : undefined;
        if (startsAt !== undefined && Number.isFinite(startsAt) && startsAt > now) {
          return reply.send({ valid: false });
        }
        if (endsAt !== undefined && Number.isFinite(endsAt) && endsAt < now) {
          return reply.send({ valid: false });
        }

        // Promotion-level usage budget (limit/used on the promotion itself).
        if (
          typeof promo.limit === "number" &&
          typeof promo.used === "number" &&
          promo.used >= promo.limit
        ) {
          return reply.send({ valid: false });
        }

        // Campaign budget — ONLY the globally-evaluable types. Per-attribute types
        // are skipped (evaluating them without the attribute would over-reject).
        const budget = promo.campaign?.budget;
        if (
          budget &&
          (budget.type === "usage" || budget.type === "spend") &&
          typeof budget.limit === "number" &&
          typeof budget.used === "number" &&
          budget.used >= budget.limit
        ) {
          return reply.send({ valid: false });
        }

        const discount = promo.application_method?.value ?? 0;
        return reply.send({ valid: true, discount });
      } catch {
        // Display-side fail-closed (unchanged from the previous behavior): an
        // errored validation never shows a discount that could die at checkout.
        return reply.send({ valid: false });
      }
    },
  );
}
