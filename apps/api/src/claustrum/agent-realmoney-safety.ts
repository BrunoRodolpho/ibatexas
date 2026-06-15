// Real-money safety rails for the live agent plane (P1 blast-radius callout).
//
// With the staging sandbox deleted, an agent trigger really executes. The
// load-bearing safety for money-moving kinds (pix.charge.refund) is no longer a
// sandbox no-op but THREE composed guards:
//   1. the B1 refund-confirm policy rule (in @adjudicate/pack-payments-pix) —
//      an agent-session refund adjudicates to REQUEST_CONFIRMATION, never
//      EXECUTE, so money never moves without an operator resolving an approval;
//   2. the B2 park-seam (live-agent-conductor.ts) that actually queues that
//      approval;
//   3. this module — a PROACTIVE per-agent / per-window circuit breaker (bounds
//      the FIRST N money attempts, which the kill switch — a reactive tail
//      bound — cannot) + a boot-time fail-closed assertion (sibling to the old
//      assertNoRealExecutors) that crashes the boot if an agent declares a
//      real-money kind without the confirm guard composed.

import type { AgentDefinition } from "@ibatexas/agents";
import { rk } from "@ibatexas/tools";
import { logger } from "../lib/logger.js";

/** Intent kinds that move real money — every one MUST be confirm-gated. */
export const REAL_MONEY_KINDS: ReadonlySet<string> = new Set<string>([
  "pix.charge.refund",
]);

/** True if the kind moves real money (so it must be confirm-gated + breakered). */
export function isRealMoneyKind(kind: string): boolean {
  return REAL_MONEY_KINDS.has(kind);
}

/**
 * Boot-time fail-closed assertion: every real-money kind any agent declares
 * MUST appear in `composedConfirmKinds` (the set the composed kernel policy
 * confirm-gates — supplied by the bootstrap from the B1 rule). Throws (crashes
 * the boot) otherwise — a real-money kind without a confirm guard is the exact
 * "money moves with no gate" failure the blast-radius callout warns about.
 */
export function assertRealMoneyConfirmGuards(
  registry: ReadonlyArray<AgentDefinition>,
  composedConfirmKinds: ReadonlySet<string>,
): void {
  const unguarded: Array<{ agentId: string; kind: string }> = [];
  for (const agent of registry) {
    for (const kind of agent.declaredIntentKinds) {
      if (REAL_MONEY_KINDS.has(kind) && !composedConfirmKinds.has(kind)) {
        unguarded.push({ agentId: agent.id, kind });
      }
    }
  }
  if (unguarded.length > 0) {
    const detail = unguarded.map((u) => `${u.agentId}:${u.kind}`).join(", ");
    throw new Error(
      `real-money safety conformance failed: ${unguarded.length} declared real-money ` +
        `kind(s) without a composed sessionId-confirm guard [${detail}] — refuse to boot ` +
        `the live agent plane (money would move with no gate). Compose the refund-confirm ` +
        `rule (B1) for these kinds before enabling the plane.`,
    );
  }
}

// ── Per-agent / per-window refund circuit breaker (proactive) ────────────────

/** Minimal Redis surface the breaker needs: a fixed-window INCR + EXPIRE. */
export interface BreakerRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RefundCircuitBreaker {
  /**
   * Account one real-money action for `agentId` in the current window and return
   * whether it is still WITHIN budget. `false` ⇒ the breaker has tripped; the
   * caller MUST NOT park/execute the money action this window. Fail-OPEN on a
   * Redis error is NOT acceptable for a money breaker — it fails CLOSED (returns
   * false) so a broker outage can never let the cap be bypassed.
   */
  tryConsume(agentId: string): Promise<boolean>;
}

export interface RefundCircuitBreakerOptions {
  readonly redis: BreakerRedis;
  /** Max real-money actions per agent per window (default 3). */
  readonly maxPerWindow?: number;
  /** Window length in seconds (default 1h). */
  readonly windowSeconds?: number;
}

/**
 * Fixed-window per-agent refund circuit breaker. The window key INCRements per
 * attempt; the first attempt sets the TTL. Over the cap ⇒ trips (returns false)
 * for the rest of the window. Fails CLOSED on Redis errors (a money breaker
 * must never be bypassed by an outage).
 */
export function createRefundCircuitBreaker(
  opts: RefundCircuitBreakerOptions,
): RefundCircuitBreaker {
  const maxPerWindow = opts.maxPerWindow ?? 3;
  const windowSeconds = opts.windowSeconds ?? 3600;
  return {
    async tryConsume(agentId) {
      const key = rk(`agent:refund:breaker:${agentId}`);
      try {
        const count = await opts.redis.incr(key);
        if (count === 1) await opts.redis.expire(key, windowSeconds);
        if (count > maxPerWindow) {
          logger.warn(
            { component: "refund-circuit-breaker", agentId, count, maxPerWindow, windowSeconds },
            "refund circuit breaker TRIPPED — real-money action suppressed for the window",
          );
          return false;
        }
        return true;
      } catch (err) {
        // Fail CLOSED: a money breaker must never open on an outage.
        logger.error(
          { component: "refund-circuit-breaker", agentId, err: (err as Error).message },
          "refund circuit breaker Redis error — failing CLOSED (action suppressed)",
        );
        return false;
      }
    },
  };
}
