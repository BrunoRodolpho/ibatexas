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
import { getRedisClient, rk, estimateDelivery, createCheckout, reaisToCentavos, MedusaRequestError, cancelStalePaymentIntent, loadSchedule, getMealPeriodFromSchedule } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
import { createCustomerService, createPaymentQueryService, prisma } from "@ibatexas/domain";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { medusaStore, medusaAdmin } from "./admin/_shared.js";

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

      const data = await medusaStore("/store/carts", {
        method: "POST",
        body: JSON.stringify(cartBody),
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
        } catch {}
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

      // Verify ownership — prevent IDOR
      const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
      if (orderCustomerId && request.customerId && orderCustomerId !== request.customerId) {
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
          // Verify ownership
          if (projection.customerId && request.customerId && projection.customerId !== request.customerId) {
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

        // Verify ownership
        const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"];
        if (orderCustomerId && request.customerId && orderCustomerId !== request.customerId) {
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
