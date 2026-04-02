// get_or_create_cart tool — retrieve or create a Medusa cart for the current customer/session.
//
// Solves the critical gap: add_to_cart, create_checkout, etc. all require a cartId,
// but no tool previously existed to obtain one. The bot was stuck and could never
// actually complete an order.
//
// Flow:
//   1. Check Redis for an active cartId (keyed by customerId or sessionId)
//   2. If found → validate via Medusa GET (ensure cart exists and isn't completed)
//   3. If valid → return cart summary
//   4. If missing/invalid → create new cart via POST /store/carts
//   5. Store new cartId in Redis (24h TTL)

import type { AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { reaisToCentavos } from "../medusa/client.js";

const CART_TTL_SECONDS = 24 * 60 * 60; // 24h — matches session TTL

interface CartSummary {
  cartId: string;
  items: Array<{ variantId: string; title: string; quantity: number; unitPrice: number }>;
  total: number;
  message: string;
}

/**
 * Build the Redis key for the active cart.
 * Uses sessionId to scope carts to individual conversation sessions.
 * This prevents stale cart data from a previous session bleeding into
 * a new conversation (ephemeral session scoping).
 * Falls back to customerId only for legacy compatibility.
 */
function cartRedisKey(ctx: AgentContext): string {
  // Session-scoped: each sessionId gets its own cart binding
  return rk(`cart:active:session:${ctx.sessionId}`);
}

/** Parse a Medusa cart response into a CartSummary. */
function parseCart(cartId: string, cart: MedusaCart): CartSummary {
  const items = (cart.items ?? []).map((item) => ({
    variantId: item.variant_id,
    title: item.title ?? "",
    quantity: item.quantity,
    unitPrice: reaisToCentavos(item.unit_price),
  }));

  // Medusa v2 returns totals in reais — convert to centavos (our convention)
  const total = reaisToCentavos(cart.total ?? 0);
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

  const message =
    itemCount > 0
      ? `Carrinho ativo com ${itemCount} item(ns). Total: R$${(total / 100).toFixed(2).replace(".", ",")}.`
      : "Carrinho vazio pronto para adicionar itens.";

  return { cartId, items, total, message };
}

interface MedusaCartItem {
  variant_id: string;
  title?: string;
  quantity: number;
  unit_price: number;
}

interface MedusaCart {
  id: string;
  items?: MedusaCartItem[];
  total?: number;
  completed_at?: string | null;
}

/** Try to fetch and validate an existing cart. Returns null if cart is gone or completed. */
async function validateExistingCart(cartId: string): Promise<MedusaCart | null> {
  try {
    const data = (await medusaStoreFetch(`/store/carts/${cartId}`)) as { cart?: MedusaCart };
    const cart = data.cart;
    if (!cart) return null;
    // Cart already completed (turned into an order) — need a fresh one
    if (cart.completed_at) return null;
    return cart;
  } catch {
    // Cart not found or Medusa error — treat as invalid
    return null;
  }
}

export async function getOrCreateCart(
  _input: unknown,
  ctx: AgentContext,
): Promise<CartSummary> {
  const redis = await getRedisClient();
  const key = cartRedisKey(ctx);

  // 1. Check Redis for existing cartId
  const existingCartId = await redis.get(key);

  if (existingCartId) {
    const cart = await validateExistingCart(existingCartId);
    if (cart) {
      // Refresh TTL on access
      await redis.expire(key, CART_TTL_SECONDS);
      return parseCart(existingCartId, cart);
    }
    // Cart is gone or completed — clean up stale key
    await redis.del(key);
  }

  // 2. Acquire creation lock to prevent TOCTOU race (two concurrent calls
  //    both see null → both POST to Medusa → duplicate carts).
  const lockKey = rk(`cart:create:lock:${ctx.sessionId}`);
  const locked = await redis.set(lockKey, "1", { NX: true, EX: 10 });
  if (!locked) {
    // Another call is creating the cart — wait briefly and retry reading
    await new Promise((r) => setTimeout(r, 500));
    const racedCartId = await redis.get(key);
    if (racedCartId) return parseCart(racedCartId, { id: racedCartId, items: [], total: 0 });
    // If still null after retry, proceed with creation (lock may have expired)
  }

  try {
    // Re-read after acquiring lock (the other caller may have finished)
    const postLockCartId = await redis.get(key);
    if (postLockCartId) {
      const cart = await validateExistingCart(postLockCartId);
      if (cart) {
        await redis.expire(key, CART_TTL_SECONDS);
        return parseCart(postLockCartId, cart);
      }
    }

    // 3. Create a new cart (customer association handled via Medusa session headers)
    const cartData = (await medusaStoreFetch("/store/carts", {
      method: "POST",
      body: JSON.stringify({}),
    })) as { cart?: { id: string } };

    const cartId = cartData.cart?.id;
    if (!cartId) {
      return {
        cartId: "",
        items: [],
        total: 0,
        message: "Erro ao criar carrinho. Tente novamente.",
      };
    }

    // 4. Persist in Redis
    await redis.set(key, cartId, { EX: CART_TTL_SECONDS });

    return {
      cartId,
      items: [],
      total: 0,
      message: `Carrinho criado (${cartId}). Pronto para adicionar itens.`,
    };
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

export const GetOrCreateCartTool = {
  name: "get_or_create_cart",
  description:
    "Obtém o carrinho ativo do cliente ou cria um novo. CHAME SEMPRE antes de add_to_cart ou create_checkout para obter o cartId.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const;
