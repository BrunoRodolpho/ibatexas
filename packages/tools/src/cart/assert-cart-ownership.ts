// Shared cart ownership verification helper.
// Ensures the cart belongs to the current customer or — for guest (unowned)
// carts — to the caller's own server-side session.

import { NonRetryableError } from "@ibatexas/types";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { medusaStoreFetch } from "./_shared.js";

interface MedusaCart {
  id: string;
  customer_id?: string | null;
}

// Guest carts are bound to a session for 48h — matches the guest session max TTL
// (apps/api ACTIVE_CARTS_TTL) so the binding never outlives the session itself.
const GUEST_CART_SESSION_TTL = 48 * 60 * 60;

/**
 * P2-SEC-GUESTCART: verify the caller's session owns an unowned (guest) cart.
 *
 * get_or_create_cart binds each session to its cart under
 * `cart:active:session:<sessionId>`. We reuse that map as the source of truth:
 * if the session is already bound to a different cartId, this is an IDOR attempt
 * (a caller pointing at someone else's guest cart) and is rejected. If the
 * session has no binding yet (cart created out-of-band, e.g. via the web proxy),
 * we claim the cart for this session with an atomic NX write so only the first
 * session wins — mirroring the claim semantics in apps/api verifyCartOwnership.
 *
 * Fails open only when Redis itself is unavailable: a hard Redis outage must not
 * take down all guest checkout, and the web-proxy layer (cart:owner:*) already
 * provides a second ownership gate for browser traffic.
 */
async function assertGuestSessionOwnsCart(cartId: string, sessionId: string): Promise<void> {
  let redis: Awaited<ReturnType<typeof getRedisClient>>;
  try {
    redis = await getRedisClient();
  } catch {
    // Redis down — fail open rather than block all guest carts.
    return;
  }

  const sessionKey = rk(`cart:active:session:${sessionId}`);
  const boundCartId = await redis.get(sessionKey);

  if (boundCartId) {
    if (boundCartId !== cartId) {
      throw new NonRetryableError("Acesso negado: este carrinho não pertence à sua sessão.");
    }
    return;
  }

  // No binding yet — claim this cart for the session (only the first caller wins).
  const claimed = await redis.set(sessionKey, cartId, { EX: GUEST_CART_SESSION_TTL, NX: true });
  if (claimed) return;

  // Lost the race — another caller bound the session in between. Re-read and
  // confirm it resolved to this same cart.
  const actual = await redis.get(sessionKey);
  if (actual && actual !== cartId) {
    throw new NonRetryableError("Acesso negado: este carrinho não pertence à sua sessão.");
  }
}

/**
 * Fetches the cart from Medusa and verifies that the cart belongs to the given
 * customerId, or — for unowned (guest) carts — to the caller's session.
 * Throws NonRetryableError on mismatch.
 *
 * @param cartId  - The Medusa cart ID to verify
 * @param customerId - The session customer ID (may be undefined for guests)
 * @param sessionId  - The caller's session ID; required to bind/verify guest carts
 * @returns The cart object from Medusa
 */
export async function assertCartOwnership(
  cartId: string,
  customerId: string | undefined,
  sessionId?: string,
): Promise<MedusaCart> {
  const data = await medusaStoreFetch(`/store/carts/${cartId}`) as { cart: MedusaCart };
  const cart = data.cart;

  if (!cart) {
    throw new NonRetryableError("Carrinho não encontrado.");
  }

  // Owned cart: must belong to the current customer.
  if (cart.customer_id) {
    if (cart.customer_id !== customerId) {
      throw new NonRetryableError("Acesso negado: este carrinho pertence a outro cliente.");
    }
    return cart;
  }

  // Unowned (guest) cart: bind it to the caller's session so a different session
  // cannot act on it (IDOR). Only enforced when we know the caller's session.
  if (sessionId) {
    await assertGuestSessionOwnsCart(cartId, sessionId);
  }

  return cart;
}
