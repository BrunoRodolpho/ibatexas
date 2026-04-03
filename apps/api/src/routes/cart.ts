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
import { getRedisClient, rk, estimateDelivery, createCheckout, reaisToCentavos, MedusaRequestError, cancelStalePaymentIntent } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import { createCustomerService } from "@ibatexas/domain";
import { medusaStore, medusaAdmin } from "./admin/_shared.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";

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
  if (!owner) {
    // First access — claim ownership
    await redis.set(ownerKey, customerId, { EX: 86400 });
    return true;
  }
  return owner === customerId;
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
      const data = await medusaStore("/store/carts", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const cartId = (data as { cart?: { id: string } }).cart?.id;
      if (cartId) await trackCartId(cartId, request.customerId ? "customer" : "guest");

      return reply.code(201).send(data);
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
        body: z.object({ variant_id: z.string(), quantity: z.number().int().min(1) }),
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

      const data = await medusaStore(`/store/carts/${request.params.id}/line-items`, {
        method: "POST",
        body: JSON.stringify(request.body),
        headers: { "Content-Type": "application/json" },
      });
      return reply.code(201).send(data);
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
        body: z.object({ quantity: z.number().int().min(1) }),
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // SEC: Verify cart ownership before mutation
      const redis = await getRedisClient();
      if (!(await verifyCartOwnership(request.params.id, request.customerId, redis))) {
        return reply.status(403).send({ statusCode: 403, error: "Forbidden", message: "Carrinho pertence a outro usuário." });
      }

      const data = await medusaStore(
        `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
        {
          method: "POST",
          body: JSON.stringify(request.body),
          headers: { "Content-Type": "application/json" },
        },
      );
      return reply.send(data);
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

      const data = await medusaStore(
        `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
        { method: "DELETE" },
      );
      return reply.send(data);
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
            quantity: z.number().int().min(1),
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
      const data = await medusaStore(`/store/carts/${request.params.id}/promotions`, {
        method: "POST",
        body: JSON.stringify(request.body),
        headers: { "Content-Type": "application/json" },
      });
      return reply.send(data);
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
          tipInCentavos: z.number().int().min(0).optional(),
          deliveryCep: z.string().optional(),
          items: z.array(z.object({
            variantId: z.string().min(1),
            quantity: z.number().int().min(1),
          })).optional(),
          pixName: z.string().optional(),
          pixEmail: z.string().email().optional(),
          pixCpf: z.string().optional(),
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

      // SEC-001: Cash/PIX requires authentication — Stripe validates identity for card payments
      const { paymentMethod, items: localItems } = request.body;
      if ((paymentMethod === "cash" || paymentMethod === "pix") && !request.customerId) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Autenticação necessária para pagamento em dinheiro/PIX.",
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
          const newCart = await medusaStore("/store/carts", {
            method: "POST",
            body: JSON.stringify({}),
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
            body: JSON.stringify({ variant_id: item.variantId, quantity: item.quantity }),
          });
        }
      }

      // Resolve PIX billing details: form fields override cached data
      let pixExtra: { customerName?: string; customerEmail?: string; customerTaxId?: string } | undefined;
      if (paymentMethod === "pix") {
        const pixName = request.body.pixName;
        const pixEmail = request.body.pixEmail;
        const pixCpf = request.body.pixCpf;

        // Try loading cached PIX details for authenticated customers
        let cached: { name?: string; email?: string; cpf?: string } | null = null;
        if (request.customerId) {
          cached = await loadCachedPixDetails(request.customerId);
        }

        pixExtra = {
          customerName: pixName ?? cached?.name,
          customerEmail: pixEmail ?? cached?.email,
          customerTaxId: pixCpf ?? cached?.cpf,
        };
      }

      const result = await createCheckout({ ...request.body, cartId }, {
        channel: Channel.Web,
        sessionId: cartId,
        customerId: request.customerId,
        userType: request.userType ?? "guest",
      }, pixExtra);

      if (!result.success) {
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
      return reply.send(cached ?? {});
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
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const data = await medusaAdmin(`/admin/orders/${request.params.orderId}`) as {
        order?: {
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
          }>;
          created_at: string;
        };
      };

      if (!data.order) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Pedido não encontrado." });
      }

      // Verify ownership — prevent IDOR
      const orderCustomerId = data.order.customer_id ?? data.order.metadata?.["customerId"];
      if (orderCustomerId && orderCustomerId !== request.customerId) {
        return reply.status(404).send({ statusCode: 404, error: "Not Found", message: "Pedido não encontrado." });
      }

      // Medusa v2 returns prices in reais — convert to centavos for frontend
      const order = {
        ...data.order,
        total: reaisToCentavos(data.order.total),
        subtotal: reaisToCentavos(data.order.subtotal),
        shipping_total: reaisToCentavos(data.order.shipping_total),
        items: data.order.items.map((i) => ({
          ...i,
          unit_price: reaisToCentavos(i.unit_price),
        })),
      };
      return reply.send({ order });
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
