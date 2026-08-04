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
import { getAuditSink } from "@ibatexas/audit-sink";
import { reaisToCentavos } from "../medusa/client.js";
import { medusaStoreAdjudicated } from "../medusa/store-adjudicated.js";
import { getRedisClient } from "../redis/client.js";
import { acquireLockAtKey, type LockHandle } from "../redis/distributed-lock.js";
import { rk } from "../redis/key.js";
import { medusaStoreFetch } from "./_shared.js";

const CART_TTL_SECONDS = 24 * 60 * 60; // 24h — matches session TTL

/** TTL of the cart-creation lock, seconds. Unchanged by F-21 (was inline `EX: 10`). */
const CART_CREATE_LOCK_TTL_SECONDS = 10;

/**
 * Acquire the cart-creation lock for a session — ownership-safe (F-21).
 *
 * ── The defect this replaces ─────────────────────────────────────────────────
 * This lock used to be taken with a CONSTANT value (`set(lockKey, "1", {NX,
 * EX:10})`) and released with an unconditional `del(lockKey)` in `finally`.
 * That is a Hard Rule #10 violation, and it was live: the `finally` ran even on
 * the branch where the SET returned null — i.e. a caller that never held the
 * lock still deleted it. Combined with the 10s TTL lapsing during a slow Medusa
 * POST, caller A's `del` destroyed caller B's FRESH lock, both proceeded, and
 * two carts were created against `rk("cart:active:session:<conversationId>")` —
 * the key that decides what a checkout BUYS.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 * A per-acquisition UUID token plus a Lua compare-and-delete release, which is
 * the pattern Hard Rule #10 names and `apps/api/src/whatsapp/session.ts`
 * (`RELEASE_LOCK_SCRIPT` / `acquireAgentLock` / `releaseAgentLock`) is the
 * reference for. The implementation is NOT re-inlined here: it is the shared
 * `acquireLockAtKey` in `../redis/distributed-lock.js`, so there is exactly one
 * release script in this package.
 *
 * Exported so the real-Redis testcontainer harness can drive the PRODUCTION
 * lock (`apps/api/src/__tests__/cart-create-lock-ownership.test.ts`). The
 * ownership property is Redis server-side atomicity; per W4 RULE 3 an in-memory
 * double cannot prove it, so the proof has to reach this function for real.
 *
 * @returns A handle whose `release()` deletes ONLY if the stored value is still
 *   this caller's token, or `null` when another caller holds the lock.
 */
export async function acquireCartCreationLock(
  sessionId: string,
): Promise<LockHandle | null> {
  return acquireLockAtKey(
    rk(`cart:create:lock:${sessionId}`),
    CART_CREATE_LOCK_TTL_SECONDS,
  );
}

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
 *
 * THIS FUNCTION IS NO LONGER THE KEY'S ONLY WRITER (LE2-023). The workflow
 * plane's `order.reorder` handler (`apps/api/src/tools/
 * register-workflow-scoped-tools.ts`) also points the session at the cart it
 * rebuilds — it has to, because it POSTs a brand-new cart and the customer is
 * then invited to check it out. Recorded here rather than only there, because
 * "who decides which cart this conversation is on" is a question a reader
 * arrives at THIS function to answer, and an out-of-date answer here sent the
 * last reader looking in the wrong place.
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
  //    F-21: ownership-safe — see `acquireCartCreationLock` above.
  const lock = await acquireCartCreationLock(ctx.sessionId);
  if (!lock) {
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
    const cartData = (await medusaStoreAdjudicated.carts.create(
      { body: {} },
      {
        sourceSubject: "cart:get-or-create-cart",
        actorPrincipal: "llm",
        auditSink: getAuditSink(),
        ...(ctx.customerId === undefined ? {} : { customerId: ctx.customerId }),
        sessionId: ctx.sessionId,
      },
    )) as { cart?: { id: string } };

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
    // F-21: release ONLY the lock we actually own. `lock` is null on the
    // acquisition-failure branch above, where the pre-fix `del` deleted a lock
    // belonging to whoever DID win — and even when we did win, the release is
    // now a compare-and-delete, so a token that expired mid-Medusa-POST and was
    // re-taken by another caller is left alone. Failure to release stays
    // non-fatal (the TTL is the backstop), exactly as before.
    await lock?.release().catch(() => {});
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
