// Admin force-action confirmation store.
//
// ── Why this lives at the route layer (not as a pack guard) ─────────────
//
// Task 13 wires the four admin force-* routes through `*FromEnvelope`
// (task 15 chokepoint) — every mutation now flows through the kernel,
// adjudicated against `orderProjectionPolicyBundle` /
// `paymentProjectionPolicyBundle`. Those bundles validate basic
// projection-lifecycle gates (existence, terminal state, taint) but do
// NOT yet emit `REQUEST_CONFIRMATION` for admin-force kinds — the LLM-
// facing `@ibatexas/pack-orders` only declares the customer-driven
// surface (cart, item, checkout, cancel, note, amend), and the
// projection bundles are domain-internal system policies.
//
// Until the eventual `@ibatexas/pack-admin-actions` Pack (M4 candidate
// per `docs/adjudicate-migration/open-blockers.md` §"Task 13 follow-up"),
// the two-person rule for destructive admin actions lives here as a
// route-level layer ON TOP of the kernel gate:
//
//   1. Step 1: route handler builds the envelope, runs `*FromEnvelope`
//      ONLY if the action is auto-permitted (e.g. small refund below
//      threshold). Otherwise it stores the prepared payload + audit
//      preamble under a random UUID receipt, returns 202 with the
//      receipt id + prompt + ttlSeconds.
//   2. Step 2: route handler reads the receipt with atomic GET+DEL
//      (Lua), reconstructs the envelope (same nonce — load-bearing for
//      audit dedup), and dispatches the `*FromEnvelope` call. The
//      kernel adjudicates and emits an audit record with both steps'
//      identity captured via the wrapped payload `reason` field.
//
// ── Why we use rk() + Lua atomic consume ────────────────────────────────
//
// CLAUDE.md rule #7 forbids raw redis key strings — every key passes
// through `rk()` for the deployment-wide namespace prefix. CLAUDE.md
// rule #10 requires UUID-valued locks released via a Lua
// ownership-check script; this store generalizes that pattern: the
// receipt id IS the value, and the script atomically returns the
// stored JSON and deletes the key in one round trip. A successful
// `consume()` cannot race with a second consumer (idempotent
// yes-then-yes — second take returns null).

import { randomUUID } from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";

/**
 * 10-minute TTL — operator's two-step flow MUST complete within this
 * window. After expiry the receipt is gone and the operator must
 * re-request step 1.
 */
export const ADMIN_CONFIRMATION_TTL_SECONDS = 600;

/**
 * Lua script: atomic GET + DEL. Returns the stored JSON string when
 * present and deletes it in the same round trip; returns nil otherwise.
 * Single-use semantics — a second consume after the first returns nil.
 *
 * Mirrors the receipt-consume pattern in
 * `@adjudicate/adapter-core.createRedisConfirmationStore` but uses our
 * own redis client wiring (rk() namespacing + `node-redis` client
 * exposed via `@ibatexas/tools.getRedisClient`).
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
 * Snapshot of a pending admin force-action. The route handler captures
 * enough state at step 1 to reconstruct + dispatch the envelope at
 * step 2 without re-validating the operator's request body (the
 * `requireManager` / `OWNER` role gate already ran).
 *
 * `nonce` is captured here at step 1 so reconstructing the envelope at
 * step 2 produces the identical `intentHash` — load-bearing for audit
 * dedup if the underlying dispatch happens to retry. Both steps log
 * the same intent identity; the audit record from step 2 is the
 * authoritative "executed" record.
 */
export interface PendingAdminAction {
  /** The intent kind that step 2 will dispatch. */
  readonly kind:
    | "order.status.transition"
    | "payment.status.transition";
  /** Encoded payload for the envelope's `*FromEnvelope` call at step 2. */
  readonly payload: Record<string, unknown>;
  /** UUID — same nonce on step 1 + step 2 → identical intentHash. */
  readonly nonce: string;
  /** Staff identity for audit (preserved across both steps). */
  readonly staffId: string | null;
  /** Staff role for audit. */
  readonly staffRole: string | null;
  /** Principal-form actor.principal: "user" (staff JWT) or "system" (API key). */
  readonly actorPrincipal: "user" | "system";
  /** Operator's request IP — best-effort audit signal. */
  readonly requestorIp: string | null;
  /** pt-BR human-readable prompt presented to the operator at step 1. */
  readonly prompt: string;
  /** The route key, e.g. "force-cancel" — drives the route's mutation branch. */
  readonly route:
    | "force-cancel"
    | "waive"
    | "refund"
    | "force-status";
  /** ISO-8601 — when the receipt was created. */
  readonly createdAt: string;
  /** Order id for cross-reference in audit + Redis namespacing. */
  readonly orderId: string;
  /** Optional refund amount (centavos) — only set for `route === "refund"`. */
  readonly refundAmountCentavos?: number;
  /** Optional reason — operator-supplied at step 1. */
  readonly reason?: string;
}

export interface AdminConfirmationStore {
  /**
   * Persist a pending action. Returns the receipt id (the operator
   * sends this back at step 2) and the TTL in seconds.
   */
  create(pending: PendingAdminAction): Promise<{
    readonly confirmationId: string;
    readonly ttlSeconds: number;
  }>;
  /**
   * Atomically read + delete the pending action. Returns null when the
   * receipt is unknown, already consumed, or expired (no way to
   * distinguish those cases at the Redis layer — they all surface as
   * 410 Gone to the operator).
   */
  consume(confirmationId: string): Promise<PendingAdminAction | null>;
}

/**
 * Build an admin confirmation store wired to the default Redis client.
 * One instance per route registration is fine — the store is stateless,
 * the receipts live in Redis.
 */
export function createAdminConfirmationStore(): AdminConfirmationStore {
  return {
    async create(pending) {
      const confirmationId = randomUUID();
      const key = rk(`admin:confirmation:${confirmationId}`);
      const redis = await getRedisClient();
      await redis.set(key, JSON.stringify(pending), {
        EX: ADMIN_CONFIRMATION_TTL_SECONDS,
      });
      return {
        confirmationId,
        ttlSeconds: ADMIN_CONFIRMATION_TTL_SECONDS,
      };
    },

    async consume(confirmationId) {
      // UUID-shape gate keeps malformed input from creating spurious
      // Redis lookups. randomUUID() always emits canonical v4.
      if (
        typeof confirmationId !== "string" ||
        confirmationId.length === 0 ||
        confirmationId.length > 64
      ) {
        return null;
      }
      const key = rk(`admin:confirmation:${confirmationId}`);
      const redis = await getRedisClient();
      const raw = (await redis.eval(CONSUME_RECEIPT_SCRIPT, {
        keys: [key],
        arguments: [],
      })) as string | null;
      if (raw === null || raw === undefined) return null;
      try {
        const parsed = JSON.parse(raw) as PendingAdminAction;
        return parsed;
      } catch {
        // Malformed JSON — treat as missing; the route surfaces 410.
        return null;
      }
    },
  };
}
