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

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getRedisClient, rk, estimateDelivery, createCheckout, reaisToCentavos, MedusaRequestError, cancelStalePaymentIntent, loadSchedule, getMealPeriodFromSchedule, isValidCpf, normalizeCpf, getTypesenseClient, COLLECTION } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import { createCustomerService, createPaymentQueryService, prisma } from "@ibatexas/domain";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { medusaStore, medusaAdmin } from "./admin/_shared.js";
import {
  adjudicateCustomerMutation,
  replyForIntent,
} from "./__shared__/customer-intent-gateway.js";

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

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

async function cachePixDetailsForCustomer(
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

    const svc = createCustomerService();
    await svc.updatePixDetails(customerId, {
      name: data.name,
      email: data.email,
      cpf: data.cpf,
    });
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

/**
 * Resolve a variant's catalog-authoritative allergens for order.item.add
 * (RC-A1 Chunk 1b / D-21.4). The kernel's `requireExplicitAllergens` guard
 * demands an explicit array (CLAUDE.md Hard Rule #1 — never infer). A published
 * Typesense product always carries an explicit `allergens: string[]` (possibly
 * empty = genuinely allergen-free → EXECUTE). FAIL-CLOSED: a missing product /
 * unavailable Typesense / absent field → `null`, which makes the kernel REFUSE
 * rather than add an item with unknown allergens. Mirrors add-to-cart's
 * `lookupProductByVariant` search (by `variantsJson`), but fail-CLOSED not -open.
 *
 * Invoked ONLY on the routed path (via the wrapper's `resolvePayload` thunk), so
 * it never runs while the cutover is inert — the legacy add-item path stays
 * byte-equivalent (no Typesense call).
 */
async function resolveVariantAllergens(variantId: string): Promise<string[] | null> {
  try {
    const client = getTypesenseClient();
    const results = await client.collections(COLLECTION).documents().search({
      q: variantId,
      query_by: "variantsJson",
      filter_by: "status:published",
      per_page: 1,
    });
    const doc = results.hits?.[0]?.document as { allergens?: unknown } | undefined;
    return Array.isArray(doc?.allergens)
      ? (doc.allergens as unknown[]).filter((a): a is string => typeof a === "string")
      : null;
  } catch {
    return null; // fail-closed: unresolved ⇒ kernel REFUSEs (never guess allergens)
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
      // RC-A1 Phase B — gate the cart create/ensure through the conductor when
      // active; byte-equivalent legacy path while inert. order.cart.ensure is the
      // anonymous get-or-create kind (auth-exempt, no cartId required). The whole
      // create (customer-Medusa-id resolve + cart POST + abandoned-cart tracking)
      // is the adjudicated mutation; it moves verbatim into the legacy closure.
      const outcome = await adjudicateCustomerMutation({
        kind: "order.cart.ensure",
        payload: {}, // OrderCartEnsurePayload: { cartId? } — a create has no input cartId.
        customerId: request.customerId ?? null,
        // OrderState for order.cart.ensure: auth-exempt (SYSTEM_OR_ANON_KINDS) +
        // executeCartOps EXECUTE; no cartId guard. Guest-tolerant. IGNORED inert.
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId: null, orderId: null } },
        legacy: async () => {
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

          const data = await medusaStore("/store/carts", {
            method: "POST",
            body: JSON.stringify(cartBody),
            headers: { "Content-Type": "application/json" },
          });

          const cartId = (data as { cart?: { id: string } }).cart?.id;
          if (cartId) await trackCartId(cartId, request.customerId ? "customer" : "guest");

          return data;
        },
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.code(201).send(outcome.result);
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
      // SEC (P2-AUTH-CARTOWN): verify ownership before reading the cart.
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }
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

      // RC-A1 Phase B — gate the add through the conductor when active;
      // byte-equivalent legacy path while inert. Ownership stays OUTSIDE.
      // order.item.add requires explicit catalog allergens (CLAUDE.md Hard Rule #1);
      // they are resolved LAZILY via resolvePayload so the Typesense lookup runs ONLY
      // on the routed path — the inert legacy path makes NO catalog call (byte-equiv).
      const outcome = await adjudicateCustomerMutation({
        kind: "order.item.add",
        // Eager payload is unused (resolvePayload overrides on the routed path; the
        // inert path never builds an envelope) — kept to document the shape.
        payload: {
          cartId: request.params.id,
          variantId: request.body.variant_id,
          quantity: request.body.quantity,
        },
        resolvePayload: async () => ({
          cartId: request.params.id,
          variantId: request.body.variant_id,
          quantity: request.body.quantity,
          // null ⇒ requireExplicitAllergens REFUSEs (fail-closed; never infer).
          allergens: await resolveVariantAllergens(request.body.variant_id),
        }),
        customerId: request.customerId ?? null,
        // OrderState for order.item.add: requireCartIdForCartOps (payload.cartId) +
        // requireExplicitAllergens (payload.allergens) + validateQuantity
        // (payload.quantity) + executeCartOps. Guest-tolerant. IGNORED while inert.
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId: request.params.id, orderId: null } },
        legacy: async () => {
          // Ensure cart is tracked for abandoned-cart detection
          await trackCartId(request.params.id, request.customerId ? "customer" : "guest");

          return medusaStore(`/store/carts/${request.params.id}/line-items`, {
            method: "POST",
            body: JSON.stringify(request.body),
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.code(201).send(outcome.result);
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

      // RC-A1 Phase B — gate the line-item quantity update through the conductor
      // when active; byte-equivalent legacy path while inert. Ownership stays
      // OUTSIDE the wrapper; the Medusa update is the adjudicated mutation.
      const outcome = await adjudicateCustomerMutation({
        kind: "order.item.update",
        // OrderItemUpdatePayload: { cartId, itemId, quantity }.
        payload: {
          cartId: request.params.id,
          itemId: request.params.itemId,
          quantity: request.body.quantity,
        },
        // Guest-tolerant: optionalAuth ⇒ customerId may be null; GUEST_CART_KINDS
        // (Chunk 0) permits guest cart-building, so the wrapper builds a guest
        // envelope rather than minting a synthetic id.
        customerId: request.customerId ?? null,
        // OrderState for order.item.update: requireCartIdForCartOps (payload.cartId)
        // + validateQuantity (payload.quantity) + clampUpdateToStockCap (reads
        // state.ctx.items[].stockCap — omitted ⇒ no clamp; the thin Medusa proxy has
        // no stock snapshot). IGNORED while inert (legacy runs).
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId: request.params.id, orderId: null } },
        legacy: () =>
          medusaStore(
            `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
            {
              method: "POST",
              body: JSON.stringify(request.body),
              headers: { "Content-Type": "application/json" },
            },
          ),
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.send(outcome.result);
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

      // RC-A1 Phase B — gate the line-item removal through the conductor when
      // active; byte-equivalent legacy path while inert. Ownership stays OUTSIDE.
      const outcome = await adjudicateCustomerMutation({
        kind: "order.item.remove",
        // OrderItemRemovePayload: { cartId, itemId }.
        payload: { cartId: request.params.id, itemId: request.params.itemId },
        customerId: request.customerId ?? null,
        // OrderState for order.item.remove: requireCartIdForCartOps (payload.cartId)
        // + executeCartOps (EXECUTE). Guest-tolerant. IGNORED while inert.
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId: request.params.id, orderId: null } },
        legacy: () =>
          medusaStore(
            `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
            { method: "DELETE" },
          ),
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.send(outcome.result);
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

      // RC-A1 Phase B — gate the bulk sync through the conductor when active;
      // byte-equivalent legacy path while inert. Ownership stays OUTSIDE; the
      // trackCartId + per-item fail-soft add loop + synced-cart read are the
      // adjudicated mutation, moved verbatim into the legacy closure.
      const outcome = await adjudicateCustomerMutation({
        kind: "order.cart.sync",
        // OrderCartSyncPayload declares per-item `allergens`, but order.cart.sync
        // is NOT in KINDS_REQUIRING_EXPLICIT_ALLERGENS (the guard does not enforce
        // them for sync — by pack design), so we carry {variantId, quantity} as the
        // HTTP body provides. Catalog allergen enrichment (same source as item.add)
        // is a documented audit-fidelity follow-up; the EXECUTE decision is correct
        // without it. Payload is audit-descriptive and IGNORED while inert.
        payload: { cartId: id, items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) },
        customerId: request.customerId ?? null,
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId: id, orderId: null } },
        legacy: async () => {
          await trackCartId(id, request.customerId ? "customer" : "guest");

          // Add each item sequentially (Medusa store API doesn't support batch add)
          for (const item of items) {
            try {
              await medusaStore(`/store/carts/${id}/line-items`, {
                method: "POST",
                body: JSON.stringify({ variant_id: item.variantId, quantity: item.quantity }),
                headers: { "Content-Type": "application/json" },
              });
            } catch (err) {
              server.log.warn({ variantId: item.variantId, err }, "line item Medusa sync failed — skipping");
            }
          }

          // Return the synced cart
          return medusaStore(`/store/carts/${id}`);
        },
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.send(outcome.result);
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
      // SEC (P2-AUTH-CARTOWN): verify ownership before mutating promotions.
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }
      // RC-A1 Phase B — gate the coupon apply through the conductor when active;
      // byte-equivalent legacy path while inert. Ownership stays OUTSIDE.
      const outcome = await adjudicateCustomerMutation({
        kind: "order.coupon.apply",
        // OrderCouponApplyPayload is { cartId, code } (single); the HTTP surface
        // takes promo_codes[]. The amend guards (requireCartIdForCartOps +
        // executeCartOps) do not inspect `code`, so we join for an audit-descriptive
        // value; the legacy applies the full promo_codes array verbatim. IGNORED inert.
        payload: { cartId: request.params.id, code: request.body.promo_codes.join(",") },
        customerId: request.customerId ?? null,
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId: request.params.id, orderId: null } },
        legacy: () =>
          medusaStore(`/store/carts/${request.params.id}/promotions`, {
            method: "POST",
            body: JSON.stringify(request.body),
            headers: { "Content-Type": "application/json" },
          }),
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.send(outcome.result);
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
      // SEC (P2-AUTH-CARTOWN): verify ownership before initializing payment.
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      // Medusa v2: payment sessions live on payment collections, not carts
      const cartData = await medusaStore(`/store/carts/${request.params.id}`) as {
        cart?: { payment_collection?: { id: string } };
      };
      let pcId = cartData.cart?.payment_collection?.id;
      if (!pcId) {
        const pcData = await medusaStore(`/store/payment-collections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cart_id: request.params.id }),
        }) as { payment_collection?: { id: string } };
        pcId = pcData.payment_collection?.id;
      }
      if (!pcId) {
        return reply.status(500).send({ error: "Failed to create payment collection" });
      }
      const body = (request.body as { provider_id?: string }) ?? {};
      const data = await medusaStore(`/store/payment-collections/${pcId}/payment-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return reply.send(data);
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

      // Idempotency: dedup double-submits / network retries before any payment or
      // cart side-effect. Prefer a client Idempotency-Key; fall back to cartId so a
      // rapid double-submit from a client that sends none is still deduped. Gate
      // sits after the cheap validations (a fixable 4xx can be retried) and before
      // the first side-effect (Medusa sync + createCheckout below).
      const idemHeader = request.headers["idempotency-key"];
      const idemToken = typeof idemHeader === "string" && idemHeader.trim() ? idemHeader.trim() : request.body.cartId;
      const idemKey = rk(`checkout:idem:${idemToken}`);
      if (!(await redis.set(idemKey, "1", { NX: true, EX: 120 }))) {
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
              await medusaStore(`/store/carts/${cartId}/line-items/${item.id}`, {
                method: "DELETE",
              }).catch(() => {});
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
          const newCart = await medusaStore("/store/carts", {
            method: "POST",
            body: JSON.stringify(newCartBody),
            headers: { "Content-Type": "application/json" },
          }) as { cart?: { id: string } };
          if (!newCart.cart?.id) {
            return reply.status(500).send({ statusCode: 500, error: "Internal", message: "Não foi possível criar um novo carrinho." });
          }
          cartId = newCart.cart.id;
          await trackCartId(cartId, request.customerId ? "customer" : "guest");
        }

        // Add local items to the (possibly new) cart
        for (const item of localItems) {
          await medusaStore(`/store/carts/${cartId}/line-items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              variant_id: item.variantId,
              quantity: item.quantity,
              metadata: item.productType ? { productType: item.productType } : undefined,
            }),
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
        // store the normalized (masked-format) value. A fixable 422 releases the
        // idempotency gate so the customer can correct and resubmit immediately.
        let normalizedFormCpf: string | undefined;
        if (pixCpf !== undefined && pixCpf.trim() !== "") {
          const normalized = normalizeCpf(pixCpf);
          if (!normalized || !isValidCpf(pixCpf)) {
            await redis.del(idemKey);
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

      // RC-A1 Phase B — gate the checkout through the conductor when active;
      // byte-equivalent legacy path while inert. ALL the pre-checks above (ownership,
      // KITCHEN_CLOSED, delivery/payment validation, SEC-001, idempotency SET-NX,
      // cart-sync + stale-PI cancellation + completed_at, CPF checksum) stay OUTSIDE
      // the wrapper; `createCheckout` (the money mutation — Stripe PI / PIX QR / off-
      // by-100 / livemode, all inside) is moved VERBATIM into the legacy closure.
      const outcome = await adjudicateCustomerMutation({
        kind: "order.checkout.create",
        // OrderCheckoutCreatePayload fields the checkout guards inspect: cartId
        // (requireCartIdForCartOps), paymentMethod (validatePaymentMethod /
        // isCardCheckout guest-card exemption). Eager — all from the request.
        payload: {
          cartId,
          paymentMethod,
          deliveryType: reqDeliveryType,
          tipInCentavos: request.body.tipInCentavos,
        },
        // Guest-tolerant: a guest CARD checkout is allowed (D-24 Ruling 2); guest
        // cash/PIX are 401'd by SEC-001 above before reaching here.
        customerId: request.customerId ?? null,
        // Eager state is minimal/superseded by resolveState below (and unused while inert).
        state: { ctx: { channel: "web", customerId: request.customerId ?? null, cartId, orderId: null } },
        // LAZY state (routed-path only → inert checkout makes NO extra Medusa call,
        // staying byte-equivalent). createCheckout computes the total today, so the
        // kernel's confirmLargeTicket/refuseAmountAboveCap (totalInCentavos) +
        // requireCartItemsForCheckout (items) read the synced Medusa cart here. A
        // fresh PIX checkout has paymentStatus null ⇒ EXECUTE (D-24 Ruling 1).
        resolveState: async () => {
          let items: Array<{ variantId: string; quantity: number; priceInCentavos: number }> = [];
          let totalInCentavos: number | null = null;
          try {
            const c = (await medusaStore(`/store/carts/${cartId}`)) as {
              cart?: { total?: number; items?: Array<{ variant_id?: string; quantity?: number; unit_price?: number }> };
            };
            items = (c.cart?.items ?? []).map((i) => ({
              variantId: i.variant_id ?? "",
              quantity: i.quantity ?? 0,
              priceInCentavos: typeof i.unit_price === "number" ? reaisToCentavos(i.unit_price) : 0,
            }));
            totalInCentavos = typeof c.cart?.total === "number" ? reaisToCentavos(c.cart.total) : null;
          } catch {
            // fail-open: best-effort kernel state; the money mutation (legacy) is unaffected.
          }
          return {
            ctx: {
              channel: "web",
              customerId: request.customerId ?? null,
              cartId,
              orderId: null,
              paymentMethod,
              fulfillment: reqDeliveryType ?? null,
              paymentStatus: null,
              items,
              totalInCentavos,
            },
          };
        },
        legacy: () =>
          createCheckout({ ...request.body, cartId }, {
            channel: Channel.Web,
            sessionId: cartId,
            customerId: request.customerId,
            userType: request.userType ?? "guest",
          }, pixExtra),
      });

      if (!outcome.ran) {
        // Kernel REFUSE/DEFER — no checkout ran. Release the idempotency gate so the
        // customer can retry (mirrors the fixable-failure release below).
        await redis.del(idemKey);
        return replyForIntent(reply, outcome.intent);
      }
      const result = outcome.result;

      if (!result.success) {
        // Fixable failure — release the idempotency gate so the customer can retry
        // immediately rather than waiting out the TTL.
        await redis.del(idemKey);
        return reply.status(400).send(result);
      }

      // Cache PIX details for authenticated customers on successful checkout
      if (result.success && paymentMethod === "pix" && request.customerId && pixExtra) {
        void cachePixDetailsForCustomer(request.customerId, {
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

      // Persist customer notes as OrderNote — best-effort, never fails checkout
      if (request.body.notes && result.orderId) {
        try {
          const displayIdMatch = /^IBX-(\d+)$/i.exec(result.orderId);
          if (displayIdMatch) {
            const displayId = Number.parseInt(displayIdMatch[1], 10);
            const projection = await prisma.orderProjection.findFirst({
              where: { displayId },
              select: { id: true },
            });
            if (projection) {
              await prisma.orderNote.create({
                data: {
                  orderId: projection.id,
                  author: "customer",
                  authorId: request.customerId ?? undefined,
                  content: request.body.notes,
                },
              });
            }
          }
        } catch {
          // note persistence is best-effort
        }
      }

      return reply.send(result);
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

      // Verify ownership — prevent IDOR. A missing caller identity (anonymous
      // request under optionalAuth) is treated as a mismatch: an owned order is
      // never readable without proving you are the owner. Order display IDs
      // (IBX-<n>) are sequential and enumerable, so anonymous reads must fail.
      const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
      if (orderCustomerId && orderCustomerId !== request.customerId) {
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
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      let { orderId } = request.params;

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
          // Verify ownership — a missing caller identity counts as a mismatch
          // (prevents anonymous enumeration of sequential IBX-<n> order IDs).
          if (projection.customerId && projection.customerId !== request.customerId) {
            return reply.status(404).send({ error: "Pedido nao encontrado." });
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

        // Verify ownership — a missing caller identity counts as a mismatch
        // (prevents anonymous enumeration of sequential IBX-<n> order IDs).
        const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
        if (orderCustomerId && orderCustomerId !== request.customerId) {
          return reply.status(404).send({ error: "Pedido nao encontrado." });
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
