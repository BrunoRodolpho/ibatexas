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
  /**
   * audit-2026-05-24 P2-5: the projection's `version` snapshot captured at
   * step 1. Step 2 forwards this into the envelope payload's
   * `expectedVersion` so the executor can REFUSE if the projection has
   * advanced between the operator's "approve" click and the second
   * operator's "confirm" click. Optional because legacy receipts
   * created before this audit didn't carry the version — those still
   * dispatch without an optimistic-concurrency check (same behavior as
   * before the fix).
   */
  readonly expectedVersion?: number;
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
 * Outcome of `consumeWithSameActorCheck` — discriminated by `kind`.
 *
 * - `ok`: the receipt matched, the consuming staff is a DIFFERENT
 *   identifiable staff member from the step-1 staff, and the caller
 *   should proceed with the pending action.
 * - `missing`: receipt unknown / expired / already consumed. Caller
 *   surfaces 410 Gone (uniform with current consumer behavior).
 * - `same_actor_violation`: P0-5 — the receipt was created by the same
 *   staffId that's now consuming it. Two-person separation-of-duty
 *   requires a different operator to execute step 2. Caller surfaces
 *   403 with a pt-BR refusal.
 * - `null_staff_violation`: P0-5-TRUE — either step's staffId is null
 *   (or empty). API-key flow on either side means the operator cannot
 *   be identified; the two-person rule cannot be enforced. Receipt is
 *   drained; caller surfaces 403.
 * - `actor_type_mismatch`: P0-5-TRUE — both sides have a non-null
 *   staffId but the actor types differ (one JWT-user, one API-key
 *   system). The same human acting via two different credential paths
 *   defeats separation of duty. Receipt is drained; caller surfaces 403.
 */
export type ConsumeWithSameActorOutcome =
  | { readonly kind: "ok"; readonly pending: PendingAdminAction }
  | { readonly kind: "missing" }
  | {
      readonly kind: "same_actor_violation";
      readonly pending: PendingAdminAction;
    }
  | {
      readonly kind: "null_staff_violation";
      readonly pending: PendingAdminAction;
      readonly reason:
        | "pending_staff_null"
        | "request_staff_null"
        | "both_staff_null";
    }
  | {
      readonly kind: "actor_type_mismatch";
      readonly pending: PendingAdminAction;
      readonly pendingActor: "user" | "system";
      readonly requestActor: "user" | "system";
    };

function normalizeStaffId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Consume a receipt and enforce the two-person rule.
 *
 * P0-5 audit finding: step 2 read the pending's `staffId` only for audit
 * — never compared `requestStaffId` against `pending.staffId`. The same
 * operator could issue both steps; the route was one-person-double-
 * click protection, not separation-of-duty. This helper centralizes the
 * comparison so all four force-action routes share the gate.
 *
 * P0-5-TRUE (deep-audit) — the original implementation skipped the
 * equality check whenever either side was null, which:
 *   - Let a single attacker holding JWT + API key satisfy both steps
 *     (one side becomes null on the API-key path).
 *   - Treated "operator unidentifiable" as ok, the OPPOSITE of fail-
 *     closed.
 *
 * New fail-closed rules:
 *   - If EITHER `requestStaffId` or `pending.staffId` is null/empty →
 *     `null_staff_violation`. The two-person rule REQUIRES two
 *     identifiable humans; an API-key step satisfies neither side.
 *   - If both staffIds are non-null but `requestActorPrincipal !==
 *     pending.actorPrincipal` → `actor_type_mismatch`. The same human
 *     cannot mix a JWT step with an API-key step.
 *   - If `requestStaffId === pending.staffId` (after both pass the
 *     null/empty checks) → `same_actor_violation`. The receipt is
 *     consumed (drained from Redis) regardless so the operator must
 *     restart from step 1.
 *   - Otherwise → `ok` with the pending payload.
 *
 * Returning the consumed pending on every refusal lets the caller emit
 * an audit/event-log entry for the refusal.
 *
 * `requestActorPrincipal` is required (no longer defaults to "user")
 * because the actor-type-mismatch check needs to know which credential
 * path the step-2 request came in on. Callers MUST pass the value they
 * derived from `principalFor(staffId)` at the route layer.
 */
export async function consumeWithSameActorCheck(
  store: AdminConfirmationStore,
  confirmationId: string,
  requestStaffId: string | null,
  requestActorPrincipal?: "user" | "system",
): Promise<ConsumeWithSameActorOutcome> {
  const pending = await store.consume(confirmationId);
  if (!pending) {
    return { kind: "missing" };
  }

  // Normalize so an empty-or-whitespace staffId is treated as null. A
  // forged JWT with `staffId: ""` would otherwise pass the strict-null
  // checks below.
  const normalizedRequest = normalizeStaffId(requestStaffId);
  const normalizedPending = normalizeStaffId(pending.staffId);

  // P0-5-TRUE: null on either side -> refuse. The two-person rule
  // requires two identifiable humans. API-key paths (system actor) do
  // not satisfy either step.
  if (normalizedRequest === null && normalizedPending === null) {
    return {
      kind: "null_staff_violation",
      pending,
      reason: "both_staff_null",
    };
  }
  if (normalizedRequest === null) {
    return {
      kind: "null_staff_violation",
      pending,
      reason: "request_staff_null",
    };
  }
  if (normalizedPending === null) {
    return {
      kind: "null_staff_violation",
      pending,
      reason: "pending_staff_null",
    };
  }

  // P0-5-TRUE: actor-type mismatch -> refuse. A staff member who
  // authenticated via JWT in step 1 cannot use the API-key path for
  // step 2 (and vice versa). When the caller passes
  // `requestActorPrincipal` we cross-check; if the caller omits it
  // (legacy callers), we default the request side to "user" — which
  // matches the previous behaviour for the user-auth code paths but
  // does NOT weaken the null-staff check above.
  const effectiveRequestActor = requestActorPrincipal ?? "user";
  if (effectiveRequestActor !== pending.actorPrincipal) {
    return {
      kind: "actor_type_mismatch",
      pending,
      pendingActor: pending.actorPrincipal,
      requestActor: effectiveRequestActor,
    };
  }

  if (normalizedRequest === normalizedPending) {
    return { kind: "same_actor_violation", pending };
  }
  return { kind: "ok", pending };
}

/** pt-BR refusal text emitted on the same-actor violation path (P0-5). */
export const SAME_ACTOR_REFUSAL_PT_BR =
  "Outro operador precisa confirmar — você iniciou a etapa 1 desta ação.";

/**
 * P0-5-TRUE — pt-BR refusal text emitted when either step's staffId is
 * null (or empty). Two-person rule requires two identifiable operators;
 * an API-key step on either side cannot satisfy it.
 */
export const NULL_STAFF_REFUSAL_PT_BR =
  "Confirmação rejeitada: a regra de dois operadores exige duas identidades de equipe — uma chamada via chave de API não satisfaz nenhuma das etapas.";

/**
 * P0-5-TRUE — pt-BR refusal text emitted when both steps carry a
 * non-null staffId but the actor types differ (one JWT-user, one
 * API-key system). The same person bouncing between credential paths
 * defeats separation-of-duty.
 */
export const ACTOR_TYPE_MISMATCH_REFUSAL_PT_BR =
  "Confirmação rejeitada: a etapa 2 precisa usar o mesmo tipo de credencial da etapa 1 (JWT de equipe ou chave de API) e ser executada por um operador diferente.";

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
