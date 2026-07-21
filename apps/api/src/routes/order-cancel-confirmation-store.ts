// Customer order-cancel confirmation store (BKL-146).
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// `POST /api/orders/:id/cancel` adjudicates `order.cancel` through the kernel.
// A PAID order returns REQUEST_CONFIRMATION (BKL-036 gatePaidCancel) — the
// customer must confirm before the cancel + payment-cancel fire. This store
// holds the parked cancel under a single-use receipt id; `POST
// /api/orders/:id/cancel/confirm` consumes it and resumes the EXECUTE through
// the kernel's `confirmationReceipt` seam (the kernel substitutes EXECUTE for
// the matching intentHash while STILL enforcing every state/taint/auth guard).
//
// ── Relationship to checkout-confirmation-store.ts ──────────────────────
//
// A direct mirror of `routes/checkout-confirmation-store.ts` (itself a mirror
// of the admin store): same rk() namespacing, the same atomic Lua GET+DEL
// single-use consume, the same UUID receipt + 10-min TTL. Cancel's parked
// payload is smaller than checkout's (no cart body / PIX details) — just the
// `order.cancel` payload + the idempotency key the confirm route re-derives
// the nonce from, so it rebuilds the IDENTICAL envelope → same intentHash →
// the receipt matches. Ownership is enforced at the route layer (the parked
// `customerId` must equal the confirming session) on top of possession of the
// single-use receipt.

import { randomUUID } from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";
import type { OrderCancelPayload } from "@ibatexas/pack-orders";

/**
 * 10-minute TTL — the customer must confirm within this window. After expiry
 * the receipt is gone and the customer restarts the cancel (which re-parks and
 * issues a fresh receipt). Mirrors CHECKOUT_CONFIRMATION_TTL_SECONDS.
 */
export const ORDER_CANCEL_CONFIRMATION_TTL_SECONDS = 600;

/**
 * Lua script: atomic GET + DEL. Returns the stored JSON string when present and
 * deletes it in the same round trip; returns nil otherwise. Single-use
 * semantics — a second consume after the first returns nil. Identical to the
 * checkout / admin store's consume script (CLAUDE.md rule #10).
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
 * Snapshot of a parked cancel captured at REQUEST_CONFIRMATION. Holds
 * everything the confirm route needs to rebuild the IDENTICAL `order.cancel`
 * envelope — same `kind`/`payload`/`nonce`/actor → same `intentHash` (schema
 * v2: `createdAt` is NOT hashed) — so the kernel matches the
 * `confirmationReceipt`.
 */
export interface PendingOrderCancel {
  /** Always the cancel kind — confirm rebuilds this envelope. */
  readonly kind: "order.cancel";
  /** The order whose cancel was parked (IDOR: must equal the confirm route's :id). */
  readonly orderId: string;
  /** The kernel payload — re-adjudicated against fresh order state on confirm. */
  readonly payload: OrderCancelPayload;
  /**
   * The idempotency key the original cancel derived its nonce from.
   * `deriveNonce(idempotencyKey)` on confirm reproduces the same nonce → same
   * intentHash → the receipt matches.
   */
  readonly idempotencyKey: string;
  /**
   * The customerId at park time. The confirm route requires
   * `customerId === request.customerId` — money-safety ownership: a different
   * logged-in customer (or a guest holding a leaked receipt) cannot confirm
   * someone else's cancel.
   */
  readonly customerId: string;
  /** pt-BR prompt the kernel emitted — RESTATED verbatim in the confirm dialog. */
  readonly prompt: string;
  /** ISO-8601 — when the receipt was created. */
  readonly createdAt: string;
}

export interface OrderCancelConfirmationStore {
  /**
   * Persist a parked cancel. Returns the receipt id (the customer sends it back
   * to `/cancel/confirm`) and the TTL in seconds.
   */
  create(pending: PendingOrderCancel): Promise<{
    readonly confirmationId: string;
    readonly ttlSeconds: number;
  }>;
  /**
   * Atomically read + delete the parked cancel. Returns null when the receipt
   * is unknown, already consumed, or expired — all three surface as 410 Gone to
   * the customer (single-use: a replay returns null).
   */
  consume(confirmationId: string): Promise<PendingOrderCancel | null>;
}

/**
 * Build an order-cancel confirmation store wired to the default Redis client.
 * Stateless — the receipts live in Redis; one instance per route registration
 * is fine.
 */
export function createOrderCancelConfirmationStore(): OrderCancelConfirmationStore {
  return {
    async create(pending) {
      const confirmationId = randomUUID();
      const key = rk(`order:cancel:confirmation:${confirmationId}`);
      const redis = await getRedisClient();
      await redis.set(key, JSON.stringify(pending), {
        EX: ORDER_CANCEL_CONFIRMATION_TTL_SECONDS,
      });
      return {
        confirmationId,
        ttlSeconds: ORDER_CANCEL_CONFIRMATION_TTL_SECONDS,
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
      const key = rk(`order:cancel:confirmation:${confirmationId}`);
      const redis = await getRedisClient();
      const raw = (await redis.eval(CONSUME_RECEIPT_SCRIPT, {
        keys: [key],
        arguments: [],
      })) as string | null;
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw) as PendingOrderCancel;
      } catch {
        // Malformed JSON — treat as missing; the route surfaces 410.
        return null;
      }
    },
  };
}
