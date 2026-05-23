// W3 D1/D2 — Redis-backed kill-switch flag store + pub/sub notifier.
//
// ── Why this lives in @ibatexas/tools ───────────────────────────────────
//
// Both the operator CLI (`ibx kernel kill-switch`) and the admin HTTP
// endpoint (`POST /api/admin/kernel/kill-switch`) need to read/write the
// same Redis flag and publish the same event channel. Putting the
// primitive here is the smallest module that both can depend on without
// pulling apps/api into the CLI.
//
// ── Redis layout ─────────────────────────────────────────────────────────
//
// Flag key:        rk("kill-switch:global")
//                  Value: JSON { enabledBy, enabledAt, reason }
//                  TTL:   24h (configurable). Auto-disengages if the
//                         operator forgets to disable — fail-safe.
//
// Pub/sub channel: rk("kill-switch:events")
//                  Payload: JSON { action: "enable"|"disable", reason,
//                                  enabledBy, at, scope:"global" }
//
// ── Why TTL? ─────────────────────────────────────────────────────────────
//
// Per `docs/adjudicate-migration/migration/05-kill-switch-strategy.md`
// §"Recovery procedure" — the runbook explicitly wants a soft-expire so
// an operator who flips the kill switch and disappears doesn't keep the
// site disabled forever. 24h is the runbook default; callers may pass a
// shorter TTL for drills.

import type { RedisClientType } from "redis";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Suffixes appended to the rk() namespace prefix. Exported so tests can
 * assert against the same key shape.
 */
export const KILL_SWITCH_KEY_SUFFIX = "kill-switch:global";
export const KILL_SWITCH_CHANNEL_SUFFIX = "kill-switch:events";

/**
 * Persisted shape stored at the flag key. The runbook requires
 * `enabledBy`, `enabledAt`, and `reason` — all three are operator-
 * supplied at enable time.
 */
export interface KillSwitchMetadata {
  /** Operator identity — staff id, "cli:<host>", or "api-key:<prefix>". */
  readonly enabledBy: string;
  /** ISO-8601 timestamp at which the switch was engaged. */
  readonly enabledAt: string;
  /** Operator-supplied human-readable reason. Required by the runbook. */
  readonly reason: string;
}

/** Pub/sub event payload — what subscribers receive. */
export interface KillSwitchEvent {
  readonly action: "enable" | "disable";
  readonly scope: "global";
  readonly enabledBy: string;
  readonly reason: string;
  readonly at: string;
}

/**
 * Minimal subset of node-redis client we depend on. The real client is
 * passed in at call time so this module is unit-testable without
 * spinning up Redis.
 */
export interface KillSwitchRedisClient {
  set(
    key: string,
    value: string,
    options?: { EX?: number },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
}

export interface KillSwitchStore {
  /**
   * Engage the kill switch. Writes the metadata + sets a TTL (default
   * 24h), then publishes an "enable" event on the channel. Returns the
   * metadata that was written.
   */
  enable(input: {
    enabledBy: string;
    reason: string;
    ttlSeconds?: number;
  }): Promise<KillSwitchMetadata>;

  /**
   * Disengage the kill switch. Deletes the flag and publishes a
   * "disable" event on the channel. Returns the prior metadata if
   * present, or null when the switch was already inactive.
   */
  disable(input: {
    enabledBy: string;
    reason: string;
  }): Promise<KillSwitchMetadata | null>;

  /**
   * Read the current state. Returns null when inactive.
   */
  status(): Promise<KillSwitchMetadata | null>;
}

/**
 * Build a kill-switch store wired to the supplied Redis client + rk()
 * namespacing helper.
 *
 * The store does NOT call `getRedisClient()` itself — callers pass the
 * client they want. This makes integration tests trivial (pass a
 * docker-redis client) while keeping production wiring explicit.
 */
export function createKillSwitchStore(deps: {
  readonly redis: KillSwitchRedisClient;
  readonly rk: (key: string) => string;
}): KillSwitchStore {
  const flagKey = deps.rk(KILL_SWITCH_KEY_SUFFIX);
  const channel = deps.rk(KILL_SWITCH_CHANNEL_SUFFIX);

  return {
    async enable({ enabledBy, reason, ttlSeconds }) {
      const metadata: KillSwitchMetadata = {
        enabledBy,
        enabledAt: new Date().toISOString(),
        reason,
      };
      await deps.redis.set(flagKey, JSON.stringify(metadata), {
        EX: ttlSeconds ?? DEFAULT_TTL_SECONDS,
      });
      const event: KillSwitchEvent = {
        action: "enable",
        scope: "global",
        enabledBy,
        reason,
        at: metadata.enabledAt,
      };
      // publish() failure is non-fatal — the canonical state is the
      // flag key. Pub/sub is best-effort notification for other
      // replicas to refresh their cache faster than the poll loop.
      try {
        await deps.redis.publish(channel, JSON.stringify(event));
      } catch {
        // Intentional — see above. The flag is durable; the channel is
        // notification only.
      }
      return metadata;
    },

    async disable({ enabledBy, reason }) {
      const prior = await this.status();
      // Delete is idempotent — calling disable on an inactive switch
      // is a no-op (operator may not know the current state).
      await deps.redis.del(flagKey);
      const event: KillSwitchEvent = {
        action: "disable",
        scope: "global",
        enabledBy,
        reason,
        at: new Date().toISOString(),
      };
      try {
        await deps.redis.publish(channel, JSON.stringify(event));
      } catch {
        // See enable() — best-effort.
      }
      return prior;
    },

    async status() {
      const raw = await deps.redis.get(flagKey);
      if (raw === null || raw === undefined) return null;
      try {
        const parsed = JSON.parse(raw) as KillSwitchMetadata;
        // Defensive: a corrupted blob should fail closed (treat as
        // inactive so operators can re-engage cleanly). Required
        // string fields:
        if (
          typeof parsed.enabledBy !== "string" ||
          typeof parsed.enabledAt !== "string" ||
          typeof parsed.reason !== "string"
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
  };
}
