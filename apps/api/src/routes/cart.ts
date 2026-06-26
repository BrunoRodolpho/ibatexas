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
} from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import { createCustomerService, createOrderCommandService, createPaymentQueryService, prisma } from "@ibatexas/domain";
import { ordersPolicyBundle, type OrderCheckoutCreatePayload, type OrderNoteAddPayload, type OrderState } from "@ibatexas/pack-orders";
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
  paymentMethod: "pix" | "card" | "cash";
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
    try {
      const displayIdMatch = /^IBX-(\d+)$/i.exec(result.orderId);
      if (displayIdMatch) {
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
        if (projection) {
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
        }
      }
    } catch {
      // note persistence is best-effort
    }
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
  let accessToken: string | undefined;
  if (result.orderId) {
    accessToken = createOrderAccessToken(result.orderId);
  } else if (result.paymentMethod === "card" && result.paymentIntentId) {
    accessToken = createOrderAccessToken(result.paymentIntentId);
  }
  return reply.send(accessToken ? { ...result, accessToken } : result);
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

  // POST /api/cart/:id/sync — bulk-sync Zustand items to Medusa cart
  app.post(
    "/api/cart/:id/sync",
    {
      schema: {
        tags: ["cart"],
        summary: "Sincronizar itens do cliente com o carrinho Medusa",
        params: CartIdParams,
        body: z.object({
          items: z.array(z.object({
            variantId: z.string(),
            quantity: z.number().int().min(1).max(99),
          })),
        }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const { items } = request.body;

      // SEC: Verify cart ownership before mutation
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      await trackCartId(id, request.customerId ? "customer" : "guest");

      // Add each item sequentially (Medusa store API doesn't support batch add)
      for (const item of items) {
        try {
          await medusaAdjudicated<{ variant_id: string; quantity: number }, unknown>({
            scope: "store",
            method: "POST",
            path: `/store/carts/${id}/line-items`,
            payload: { variant_id: item.variantId, quantity: item.quantity },
            intentKind: "medusa.cart.line_items.add",
            idempotencyKey: `sync:${id}:${item.variantId}:${randomUUID()}`,
            sourceSubject: `route:POST /api/cart/:id/sync:cust:${request.customerId ?? "guest"}`,
            headers: { "Content-Type": "application/json" },
            auditSink: getAuditSink(),
            log: server.log,
          });
        } catch (err) {
          // REFUSE/DEFER/REVIEW for a single item should not abort the
          // whole sync — log and continue, matching the pre-migration
          // behaviour of swallowing transport-level errors.
          if (
            err instanceof MedusaAdjudicateRefusedError ||
            err instanceof MedusaAdjudicateDeferredError ||
            err instanceof MedusaAdjudicateNeedsReviewError
          ) {
            server.log.warn(
              { variantId: item.variantId, kind: err.name },
              "line item Medusa sync refused/deferred — skipping",
            );
          } else {
            server.log.warn({ variantId: item.variantId, err }, "line item Medusa sync failed — skipping");
          }
        }
      }

      // Return the synced cart
      const data = await medusaStore(`/store/carts/${id}`);
      return reply.send(data);
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
          pixEmail: z.string().email().optional(),
          pixCpf: z.string().optional(),
          notes: z.string().max(500).optional(),
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

      // Block food orders when restaurant is closed — frozen/merch always allowed
      const schedule = await loadSchedule();
      const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
      const mealPeriod = getMealPeriodFromSchedule(schedule, tz);
      if (mealPeriod === "closed") {
        const hasKitchenItems = (request.body.items ?? []).some((i) => i.productType === "food");
        if (hasKitchenItems) {
          return reply.status(422).send({
            statusCode: 422,
            error: "Unprocessable Entity",
            message: "A cozinha está fechada no momento. Itens de comida não podem ser pedidos agora.",
            code: "KITCHEN_CLOSED",
          });
        }
      }

      // Validate delivery type + payment method + cart composition combinations
      const { paymentMethod, deliveryType: reqDeliveryType, items: localItems } = request.body;
      if (reqDeliveryType === "shipping") {
        const hasNonMerch = (localItems ?? []).some((i) => i.productType !== "merchandise");
        if (hasNonMerch) {
          return reply.status(422).send({
            statusCode: 422,
            error: "Unprocessable Entity",
            message: "Apenas produtos da loja podem ser enviados pelo correio. Itens de comida e congelados precisam de entrega local ou retirada.",
            code: "SHIPPING_NON_MERCHANDISE",
          });
        }
        if (paymentMethod === "cash") {
          return reply.status(422).send({
            statusCode: 422,
            error: "Unprocessable Entity",
            message: "Pagamento em dinheiro não disponível para envios. Escolha PIX ou cartão.",
            code: "CASH_NOT_ALLOWED_FOR_SHIPPING",
          });
        }
      }
      if (reqDeliveryType === "dine_in") {
        const hasFoodItems = (localItems ?? []).some((i) => i.productType === "food");
        if (!hasFoodItems) {
          return reply.status(422).send({
            statusCode: 422,
            error: "Unprocessable Entity",
            message: "Comer no restaurante disponível apenas para pedidos com itens de comida.",
            code: "DINEIN_REQUIRES_FOOD",
          });
        }
      }

      // SEC-001: Cash/PIX requires authentication — Stripe validates identity for card payments
      if ((paymentMethod === "cash" || paymentMethod === "pix") && !request.customerId) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Autenticação necessária para pagamento em dinheiro/PIX.",
        });
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
        let needsNewCart = false;

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
            needsNewCart = true;
          } else if (existingCart.cart?.payment_collection?.payment_sessions?.length) {
            // Cancel Stripe PIs to prevent orphaned QR codes from charging the customer
            for (const session of existingCart.cart.payment_collection.payment_sessions) {
              const piId = session.data?.id;
              if (piId && session.provider_id.includes("stripe")) {
                await cancelStalePaymentIntent(piId).catch(() => {});
              }
            }
            needsNewCart = true;
          } else {
            // Cart is clean — just clear old items before re-adding
            const existingItems = existingCart.cart?.items ?? [];
            for (const item of existingItems) {
              await medusaAdjudicated<undefined, unknown>({
                scope: "store",
                method: "DELETE",
                path: `/store/carts/${cartId}/line-items/${item.id}`,
                intentKind: "medusa.cart.line_items.remove",
                idempotencyKey: `checkout-clear:${cartId}:${item.id}`,
                sourceSubject: `route:POST /api/cart/checkout:cust:${request.customerId ?? "guest"}`,
                auditSink: getAuditSink(),
                log: server.log,
              }).catch((err) => {
                // Best-effort clear — matches the pre-migration catch(() => {})
                // semantics. The kernel may REFUSE on a terminal cart; that's
                // surfaced via the wrapper's typed error and silenced here so
                // the checkout flow can still create a fresh cart below.
                server.log.warn(
                  { err: (err as Error).message ?? String(err), itemId: item.id },
                  "[cart/checkout] clear-existing-item failed — continuing",
                );
              });
            }
          }
        } catch (err) {
          // Cart doesn't exist in Medusa (purged/expired) — create fresh
          if (err instanceof MedusaRequestError && err.statusCode === 404) {
            needsNewCart = true;
          } else {
            throw err;
          }
        }

        if (needsNewCart) {
          // Bind customer to new cart so the order is linked to their account
          let newCartBody: Record<string, unknown> = {};
          if (request.customerId) {
            try {
              const customerSvc = createCustomerService();
              const customer = await customerSvc.getById(request.customerId);
              if (customer.medusaId) {
                newCartBody = { customer_id: customer.medusaId };
              }
            } catch {
              // Fall through — create as guest
            }
          }
          const newCart = await medusaAdjudicated<Record<string, unknown>, { cart?: { id: string } }>({
            scope: "store",
            method: "POST",
            path: "/store/carts",
            payload: newCartBody,
            intentKind: "medusa.cart.create",
            idempotencyKey: `checkout-new-cart:${request.body.cartId}:${randomUUID()}`,
            sourceSubject: `route:POST /api/cart/checkout:cust:${request.customerId ?? "guest"}`,
            headers: { "Content-Type": "application/json" },
            auditSink: getAuditSink(),
            log: server.log,
          });
          if (!newCart.cart?.id) {
            return reply.status(500).send({ statusCode: 500, error: "Internal", message: "Não foi possível criar um novo carrinho." });
          }
          cartId = newCart.cart.id;
          await trackCartId(cartId, request.customerId ? "customer" : "guest");
        }

        // Add local items to the (possibly new) cart
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
            sourceSubject: `route:POST /api/cart/checkout:cust:${request.customerId ?? "guest"}`,
            headers: { "Content-Type": "application/json" },
            auditSink: getAuditSink(),
            log: server.log,
          });
        }
      }

      // Resolve PIX billing details: form fields override cached data
      let pixExtra: { customerName?: string; customerEmail?: string; customerTaxId?: string } | undefined;
      if (paymentMethod === "pix") {
        const pixName = request.body.pixName;
        const pixEmail = request.body.pixEmail;
        const pixCpf = request.body.pixCpf;

        // P1-DATA-CPF: validate the CPF checksum at the trust boundary before it
        // flows to Stripe (billing_details.tax_id) and Prisma. The Zod schema only
        // checks it's a string; reuse the Receita Federal checksum validator and
        // store the normalized (masked-format) value. Invalid → fixable 422; the
        // request is rejected before the adjudicate envelope is built, so no
        // checkout nonce is committed and the customer can correct and resubmit.
        // (Cached CPF was already validated on entry via set_pix_details.)
        let normalizedFormCpf: string | undefined;
        if (pixCpf !== undefined && pixCpf.trim() !== "") {
          const normalized = normalizeCpf(pixCpf);
          if (!normalized || !isValidCpf(pixCpf)) {
            return reply.status(422).send({
              statusCode: 422,
              error: "Unprocessable Entity",
              message: "CPF inválido. Verifique os dígitos e tente novamente. Formato: 000.000.000-00.",
              code: "INVALID_CPF",
            });
          }
          normalizedFormCpf = normalized;
        }

        // Try loading cached PIX details for authenticated customers
        let cached: { name?: string; email?: string; cpf?: string } | null = null;
        if (request.customerId) {
          cached = await loadCachedPixDetails(request.customerId);
        }

        pixExtra = {
          customerName: pixName ?? cached?.name,
          customerEmail: pixEmail ?? cached?.email,
          customerTaxId: normalizedFormCpf ?? cached?.cpf,
        };
      }

      // ── Task 14 — wrap checkout in adjudicate envelope ────────────────
      //
      // Build the `order.checkout.create` envelope with the customer-actor
      // signature. The kernel may EXECUTE / REWRITE / REFUSE / DEFER (PIX
      // pending) / REQUEST_CONFIRMATION (large-ticket) / ESCALATE here —
      // the gateway dispatches `createCheckout` only on EXECUTE / REWRITE.
      //
      // For guest carts (no customerId), `sessionId` falls back to the
      // cartId so envelopes from anonymous flows still have a stable key
      // for audit + park bookkeeping.
      const checkoutPayload: OrderCheckoutCreatePayload = {
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

      const sessionId = request.customerId ?? cartId;
      // ── P0-7 (audit-2026-05-24) — deterministic idempotency-key ─────────
      //
      // POST /api/cart/checkout creates a payment (PIX/card/cash) and
      // an order. A retry on the same cart MUST dedupe to avoid double
      // payment. Prefer the client's `Idempotency-Key` header; fall back
      // to `${cartId}:checkout` (a cart is logically checked out once).
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
      // (loaded by cartId) via the shared resolve-and-assemble builder, so the web
      // checkout adjudicates against the same ctx the conductor uses.
      // ⚠️ BEHAVIOR CHANGE (ratified): this now loads the real cart total, so the
      // large-ticket guards apply at web checkout — confirmLargeTicket (≥ R$1.000)
      // → REQUEST_CONFIRMATION (HTTP 202) and refuseAmountAboveCap (≥ R$10.000) →
      // REFUSE (403). The web frontend MUST handle the 202 confirmation reply, or
      // orders ≥ R$1.000 will not complete. (paymentStatus stays null via the
      // builder so the PIX-pending guard does NOT DEFER at checkout — unchanged.)
      const guestKey = request.customerId ?? `guest:${cartId}`;
      // T1a-13 fix: thread the request's deliveryType into the ctx builder —
      // buildCartCtx maps it onto ctx.fulfillment, which the pack's
      // requireSlotsFilledForCheckout guard requires non-null. Without it the
      // guard 403'd EVERY web checkout with order.checkout.slots_incomplete
      // (surfaced by the first JOURNEY-001 live run). Absent deliveryType
      // still refuses — the customer genuinely hasn't picked a fulfillment.
      const orderState = {
        ctx: await loadCartCtx(
          identityCtx(guestKey, "web"),
          {
            paymentMethod,
            ...(reqDeliveryType !== undefined ? { deliveryType: reqDeliveryType } : {}),
          } as Record<string, unknown>,
          { cartId },
        ),
      } as unknown as OrderState;

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

      // ── REQUEST_CONFIRMATION (large-ticket ≥ R$1.000) — park the prepared
      // checkout under a single-use receipt and ask the customer to confirm.
      // The gateway already mapped a 202 { confirmationRequired, prompt }; we
      // enrich it with the confirmationId the customer sends back to
      // POST /api/cart/checkout/confirm. (Without this, the 202 carries no
      // resume handle and orders ≥ R$1.000 could not complete.)
      if (out.decision.kind === "REQUEST_CONFIRMATION") {
        const prompt = out.decision.prompt;
        const parked = await checkoutConfirmationStore.create({
          kind: "order.checkout.create",
          payload: checkoutPayload,
          idempotencyKey: checkoutIdempotencyKey,
          cartId,
          customerId: sessionId,
          userType: request.userType ?? "guest",
          checkoutBody: request.body as Record<string, unknown>,
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

      // ── Other non-EXECUTE/REWRITE branches (REFUSE 403 / DEFER 202 /
      // ESCALATE 503) — surface the gateway's reply verbatim (it already
      // mapped pt-BR copy + status code).
      if (out.decision.kind !== "EXECUTE" && out.decision.kind !== "REWRITE") {
        return reply.code(out.statusCode).send(out.body);
      }

      // ── EXECUTE / REWRITE: apply post-checkout side effects + respond.
      const result = out.body as Awaited<ReturnType<typeof createCheckout>>;
      return finalizeCheckout({
        reply,
        result,
        cartId,
        paymentMethod,
        customerId: request.customerId,
        ...(pixExtra ? { pixExtra } : {}),
        ...(request.body.notes ? { notes: request.body.notes } : {}),
        onFixableFailure: async () => {
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
        // R0a — optional signed per-order access token (`?t=`) for guest reads.
        querystring: z.object({ t: z.string().optional() }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
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

      let order: MedusaOrder | undefined;
      const { orderId } = request.params;

      if (orderId.startsWith("pi_")) {
        // PIX/card: orderId is a Stripe PaymentIntent ID — order may not exist yet
        // (created only after Stripe webhook fires). Search by metadata.
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
          return reply.status(202).send({
            status: "pending",
            paymentIntentId: orderId,
            message: "Aguardando confirmação do pagamento. O pedido será criado automaticamente após a confirmação.",
          });
        }
      } else if (/^IBX-\d+$/i.test(orderId)) {
        // Display ID format (e.g. "IBX-0004") — resolve to Medusa order via OrderProjection
        const displayId = Number.parseInt(orderId.replace(/^IBX-/i, ""), 10);
        const projection = await prisma.orderProjection.findFirst({
          where: { displayId },
          select: { id: true },
        });
        if (projection) {
          const data = await medusaAdmin(`/admin/orders/${projection.id}`) as { order?: MedusaOrder };
          order = data.order;
        } else {
          // Fallback: projection not created yet (NATS subscriber lag) — query Medusa by display_id
          try {
            const searchData = await medusaAdmin(
              `/admin/orders?display_id=${displayId}&limit=1`,
            ) as { orders?: MedusaOrder[] };
            order = searchData.orders?.[0];
          } catch {
            // Medusa query failed
          }
          if (!order) {
            return reply.status(202).send({
              status: "pending",
              message: "Aguardando confirmação do pedido...",
            });
          }
        }
      } else {
        const data = await medusaAdmin(`/admin/orders/${orderId}`) as { order?: MedusaOrder };
        order = data.order;
      }

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
        accessToken: request.query.t,
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
        // R0a — optional signed per-order access token (`?t=`) for guest polls.
        querystring: z.object({ t: z.string().optional() }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      let { orderId } = request.params;
      // R0a — capture the caller-supplied id BEFORE the IBX-/pi_ → Medusa-id
      // resolution below: the per-order token is bound to the exact id the
      // client holds (== the /pedido/<id> route param), not the resolved id.
      const orderIdParam = orderId;
      const accessToken = request.query.t;

      // Resolve IBX-XXXX display ID to Medusa order ID
      if (/^IBX-\d+$/i.test(orderId)) {
        const displayId = Number.parseInt(orderId.replace(/^IBX-/i, ""), 10);
        const proj = await prisma.orderProjection.findFirst({
          where: { displayId },
          select: { id: true },
        });
        if (proj) {
          orderId = proj.id;
        } else {
          // Fallback: projection not created yet (NATS subscriber lag) — query Medusa by display_id
          try {
            const searchData = await medusaAdmin(
              `/admin/orders?display_id=${displayId}&limit=1&fields=id`,
            ) as { orders?: Array<{ id: string }> };
            if (searchData.orders?.[0]?.id) {
              orderId = searchData.orders[0].id;
            }
          } catch {
            // Will fall through to existing 202 handling
          }
        }
      }

      try {
        // Primary: read from projection
        const { createOrderQueryService: createQS } = await import("@ibatexas/domain");
        const querySvc = createQS();
        const projection = await querySvc.getById(orderId);

        if (projection) {
          // R0a — deny-null-owner IDOR guard (SDD Inv 2/13). Authorize iff the
          // authenticated caller owns the order OR a valid signed per-order
          // token bound to this id is presented. A null owner no longer leaks:
          // "no owner" ≠ "any owner".
          if (!isOrderReadAuthorized({
            orderCustomerId: projection.customerId,
            requestCustomerId: request.customerId,
            orderIdParam,
            accessToken,
          })) {
            return reply.status(404).send({ error: "Pedido não encontrado." });
          }
          const pqs = createPaymentQueryService();
          const cp = await pqs.getActiveByOrderId(orderId).catch(() => null);
          reply.header("Cache-Control", "no-store");
          return reply.send({
            status: projection.fulfillmentStatus,
            paymentStatus: cp ? cp.status : null,
            updatedAt: projection.updatedAt?.toISOString() ?? null,
            source: "projection",
          });
        }

        // Fallback: projection not found — use Medusa (backfill grace + pi_ lookup)
        server.log.warn({ orderId }, "projection_fallback_used — order status poll");
        let order: { fulfillment_status?: string; status?: string; updated_at?: string; customer_id?: string; metadata?: Record<string, string> } | undefined;

        if (orderId.startsWith("pi_")) {
          const searchData = await medusaAdmin(`/admin/orders?metadata[stripePaymentIntentId]=${encodeURIComponent(orderId)}&limit=1&fields=fulfillment_status,status,updated_at,customer_id,metadata`) as {
            orders?: Array<typeof order>;
          };
          order = searchData.orders?.[0];
        } else {
          const data = await medusaAdmin(`/admin/orders/${orderId}?fields=fulfillment_status,status,updated_at,customer_id,metadata`) as {
            order?: typeof order;
          };
          order = data.order;
        }

        if (!order) {
          return reply.status(202).send({ status: "pending", updatedAt: null });
        }

        // R0a — deny-null-owner IDOR guard (SDD Inv 2/13), Medusa-fallback path.
        // Authorize iff the authenticated caller owns the order OR a valid
        // signed per-order token bound to this id is presented.
        const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
        if (!isOrderReadAuthorized({
          orderCustomerId,
          requestCustomerId: request.customerId,
          orderIdParam,
          accessToken,
        })) {
          return reply.status(404).send({ error: "Pedido não encontrado." });
        }

        // Medusa uses "not_fulfilled" / "fulfilled" / "canceled" etc.
        // Normalize to our domain vocabulary so the frontend stays consistent.
        const rawStatus = order.fulfillment_status ?? order.status ?? "pending";
        const MEDUSA_STATUS_MAP: Record<string, string> = {
          not_fulfilled: "pending",
          fulfilled: "delivered",
          partially_fulfilled: "preparing",
          returned: "canceled",
          requires_action: "pending",
        };
        const normalizedStatus = MEDUSA_STATUS_MAP[rawStatus] ?? rawStatus;

        reply.header("Cache-Control", "no-store");
        return reply.send({
          status: normalizedStatus,
          updatedAt: order.updated_at ?? null,
          source: "medusa_fallback",
        });
      } catch (err) {
        server.log.error(err, "Failed to fetch order status");
        reply.code(502).send({ error: "Failed to fetch order status" });
      }
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
      // Query Medusa for promotions matching the code
      try {
        const data = await medusaAdmin(`/admin/promotions?code=${encodeURIComponent(request.body.code)}&limit=1`) as {
          promotions?: Array<{
            id: string;
            code: string;
            is_disabled: boolean;
            application_method?: {
              value?: number;
              type?: string;
            };
          }>;
        };

        const promo = data.promotions?.[0];
        if (!promo || promo.is_disabled) {
          return reply.send({ valid: false });
        }

        const discount = promo.application_method?.value ?? 0;
        return reply.send({ valid: true, discount });
      } catch {
        return reply.send({ valid: false });
      }
    },
  );
}
