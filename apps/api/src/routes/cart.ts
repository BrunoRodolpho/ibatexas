// Cart proxy routes — forward cart operations to Medusa Store API
//
// POST   /api/cart                          — create cart
// GET    /api/cart/:id                      — get cart
// POST   /api/cart/:id/line-items           — add line item
// DELETE /api/cart/:id/line-items/:itemId   — remove line item
// PATCH  /api/cart/:id/line-items/:itemId   — update line item quantity
// POST   /api/cart/:id/promotions           — apply promotion code
// POST   /api/cart/:id/payment-sessions     — initialize payment sessions
//
// All session cart IDs are tracked in Redis active:carts set for abandoned-cart detection.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getRedisClient, rk } from "@ibatexas/tools";
import { medusaStore } from "./admin/_shared.js";
import { optionalAuth } from "../middleware/auth.js";

const CartIdParams = z.object({ id: z.string().min(1) });
const CartItemParams = z.object({ id: z.string().min(1), itemId: z.string().min(1) });

/** Register cartId in active:carts tracking set for abandoned-cart detection. */
async function trackCartId(cartId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.sAdd(rk("active:carts"), cartId);
}

/** Remove cartId from active:carts (called when order is placed). */
export async function untrackCartId(cartId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.sRem(rk("active:carts"), cartId);
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
      const body: Record<string, unknown> = {};
      if (request.customerId) body["customer_id"] = request.customerId;

      const data = await medusaStore("/store/carts", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

      const cartId = (data as { cart?: { id: string } }).cart?.id;
      if (cartId) await trackCartId(cartId);

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
      // Ensure cart is tracked for abandoned-cart detection
      await trackCartId(request.params.id);

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
      const data = await medusaStore(
        `/store/carts/${request.params.id}/line-items/${request.params.itemId}`,
        { method: "DELETE" },
      );
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

  // POST /api/cart/:id/payment-sessions — initialize payment
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
      const data = await medusaStore(`/store/carts/${request.params.id}/payment-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return reply.send(data);
    },
  );
}
