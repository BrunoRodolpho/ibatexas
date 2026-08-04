// Customer checkout confirmation store.
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// `POST /api/cart/checkout` now adjudicates against the REAL cart total
// (resolve-and-assemble Phase 2). The orders pack's `confirmLargeTicket`
// guard returns REQUEST_CONFIRMATION for orders ≥ R$1.000, so the web
// route parks the prepared checkout and asks the customer to confirm
// before the payment fires. This store holds the parked checkout under a
// single-use receipt id; `POST /api/cart/checkout/confirm` consumes it and
// resumes the EXECUTE through the kernel's `confirmationReceipt` seam.
//
// ── Relationship to admin-confirmation-store.ts ─────────────────────────
//
// This mirrors `routes/admin/admin-confirmation-store.ts` — same rk()
// namespacing, the same atomic Lua GET+DEL single-use consume, the same
// UUID receipt + TTL. It deliberately OMITS the admin store's two-person
// rule (`consumeWithSameActorCheck`): a customer confirming their own
// order is one identity, not a separation-of-duty flow. Ownership is
// enforced at the route layer (the parked `customerId` must match the
// confirming session) on top of possession of the single-use receipt.
//
// ── PII note ────────────────────────────────────────────────────────────
//
// `PendingCheckout` carries the customer's own checkout body + resolved
// PIX billing details so the confirm route can rebuild the identical
// envelope + executor. This is the customer's own data, single-use, and
// short-lived (10-min TTL), drained atomically on consume — the same
// posture as the admin store's pending payload.

import { randomUUID } from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";
import type { UserType } from "@ibatexas/types";
import type { OrderCheckoutCreatePayload } from "@ibatexas/pack-orders";

/**
 * 10-minute TTL — the customer must confirm within this window. After
 * expiry the receipt is gone and the customer restarts checkout (which
 * re-parks and issues a fresh receipt).
 */
export const CHECKOUT_CONFIRMATION_TTL_SECONDS = 600;

/**
 * Lua script: atomic GET + DEL. Returns the stored JSON string when
 * present and deletes it in the same round trip; returns nil otherwise.
 * Single-use semantics — a second consume after the first returns nil.
 * Identical to the admin store's consume script (CLAUDE.md rule #10).
 */
const CONSUME_RECEIPT_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
  return value
else
  return nil
end
`;

/**
 * Snapshot of a parked checkout captured at REQUEST_CONFIRMATION. Holds
 * everything the confirm route needs to (a) rebuild the IDENTICAL
 * `order.checkout.create` envelope — same `kind`/`payload`/`nonce`/actor
 * → same `intentHash` (schema v2: `createdAt` is NOT hashed), so the
 * kernel matches the `confirmationReceipt` — and (b) reconstruct the
 * `createCheckout` executor.
 */
export interface PendingCheckout {
  /** Always the checkout-create kind — confirm rebuilds this envelope. */
  readonly kind: "order.checkout.create";
  /** The kernel payload — re-adjudicated against fresh cart state on confirm. */
  readonly payload: OrderCheckoutCreatePayload;
  /**
   * The idempotency key the original checkout derived its nonce from.
   * `deriveCartNonce(idempotencyKey)` on confirm reproduces the same
   * nonce → same intentHash → the receipt matches.
   */
  readonly idempotencyKey: string;
  /** The FINAL cart id used at park time (may be a fresh cart the route created). */
  readonly cartId: string;
  /**
   * The envelope actor sessionId at park time (`request.customerId ?? cartId`).
   * The confirm route requires `customerId === (request.customerId ?? cartId)`
   * — money-safety ownership: a different session cannot confirm this order.
   */
  readonly customerId: string;
  /** `request.userType ?? "guest"` — forwarded into the createCheckout context. */
  readonly userType: UserType;
  /** The original checkout request body — rebuilds the createCheckout input. */
  readonly checkoutBody: Record<string, unknown>;
  /** Resolved PIX billing details (form-or-cached), when paymentMethod === "pix". */
  readonly pixExtra?: {
    readonly customerName?: string;
    readonly customerEmail?: string;
    readonly customerTaxId?: string;
  };
  /** pt-BR prompt the pack emitted — shown to the customer in the confirm dialog. */
  readonly prompt: string;
  /** ISO-8601 — when the receipt was created. */
  readonly createdAt: string;
}

/**
 * The Redis-shaped client this store reads and writes through — R5 rollout.
 *
 * EXHAUSTIVE and deliberately narrow: `set` is `create`'s single write, `eval`
 * is `consume`'s atomic GET+DEL. Nothing else in this file touches Redis.
 *
 * Fail-closed analysis: both members are ISSUED unconditionally once their
 * method is reached, and neither is feature-detected (`typeof c.X ===
 * "function"` — the shape that made the park path's `evalIncrCheck` degrade
 * silently). `consume`'s only `try/catch` wraps `JSON.parse`, NOT the `eval`,
 * so a client that cannot serve `eval` throws out of the route rather than
 * turning every receipt into a 410. The UUID-shape gate above the `eval` is the
 * one path that reaches Redis never, and it stays that way.
 */
export type CheckoutConfirmationRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "set" | "eval"
>;

/**
 * Injection point for the store's Redis client.
 *
 * A RESOLVER (`() => Promise<client>`) rather than an instance, deliberately:
 * `cartRoutes` builds this store in its synchronous registration phase and has
 * no client in hand there. Taking an instance would force the route to `await
 * getRedisClient()` at registration — hoisting a resolution that today happens
 * per receipt, and opening a connection on a process that may never park a
 * large-ticket checkout at all.
 */
export interface CheckoutConfirmationStoreOptions {
  /**
   * Resolves the client each command runs on. Defaults to the process
   * singleton, resolved at the SAME point inside `create`/`consume` it always
   * was — so `createCheckoutConfirmationStore()` with no argument is
   * byte-identical to what this module did before.
   */
  readonly redis?: () => Promise<CheckoutConfirmationRedis>;
}

export interface CheckoutConfirmationStore {
  /**
   * Persist a parked checkout. Returns the receipt id (the customer sends
   * it back to `/checkout/confirm`) and the TTL in seconds.
   */
  create(pending: PendingCheckout): Promise<{
    readonly confirmationId: string;
    readonly ttlSeconds: number;
  }>;
  /**
   * Atomically read + delete the parked checkout. Returns null when the
   * receipt is unknown, already consumed, or expired — all three surface
   * as 410 Gone to the customer (single-use: a replay returns null).
   */
  consume(confirmationId: string): Promise<PendingCheckout | null>;
}

/**
 * Build a checkout confirmation store. Stateless — the receipts live in Redis;
 * one instance per route registration is fine.
 *
 * With no options the client is the process singleton (the pre-R5 behaviour,
 * unchanged); `cartRoutes` passes its own `deps.redis` so the store runs on the
 * family's client.
 */
export function createCheckoutConfirmationStore(
  options?: CheckoutConfirmationStoreOptions,
): CheckoutConfirmationStore {
  /** One touch, one resolution — never hoisted out of the method that needs it. */
  const resolveClient = (): Promise<CheckoutConfirmationRedis> =>
    options?.redis ? options.redis() : getRedisClient();

  return {
    async create(pending) {
      const confirmationId = randomUUID();
      const key = rk(`checkout:confirmation:${confirmationId}`);
      const redis = await resolveClient();
      await redis.set(key, JSON.stringify(pending), {
        EX: CHECKOUT_CONFIRMATION_TTL_SECONDS,
      });
      return {
        confirmationId,
        ttlSeconds: CHECKOUT_CONFIRMATION_TTL_SECONDS,
      };
    },

    async consume(confirmationId) {
      // UUID-shape gate keeps malformed input from creating spurious Redis
      // lookups. randomUUID() always emits canonical v4.
      if (
        typeof confirmationId !== "string" ||
        confirmationId.length === 0 ||
        confirmationId.length > 64
      ) {
        return null;
      }
      const key = rk(`checkout:confirmation:${confirmationId}`);
      const redis = await resolveClient();
      const raw = (await redis.eval(CONSUME_RECEIPT_SCRIPT, {
        keys: [key],
        arguments: [],
      })) as string | null;
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw) as PendingCheckout;
      } catch {
        // Malformed JSON — treat as missing; the route surfaces 410.
        return null;
      }
    },
  };
}
