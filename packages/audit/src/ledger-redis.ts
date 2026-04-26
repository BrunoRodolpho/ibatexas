/**
 * Redis implementation of the Execution Ledger.
 *
 * Uses SET NX + TTL. First writer wins; subsequent writers are no-ops.
 * Reads deserialize JSON. Keys are namespaced via an adopter-supplied
 * key builder (e.g., the IbateXas adopter passes its own `rk()` helper).
 *
 * This is NOT a durable audit sink. Use AuditSink for that.
 */

import type { Ledger, LedgerHit, LedgerRecordInput } from "./ledger.js";

/**
 * Minimal Redis-like interface. Works with redis@4+ and any client that
 * exposes these three methods. Adopters inject their own client.
 */
export interface RedisLedgerClient {
  /**
   * SET with NX + EX semantics. Returns "OK" or similar truthy when the write
   * happened, null-ish when a value already existed and NX rejected the write.
   */
  set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number },
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
}

export interface CreateRedisLedgerOptions {
  readonly client: RedisLedgerClient;
  /**
   * Key builder — wraps a raw suffix into a namespaced key. Adopters supply
   * their own namespacing helper (e.g., the IbateXas adopter passes its
   * `rk()` from `@ibatexas/tools` to apply the `${APP_ENV}:` prefix; clinic
   * or salon adopters supply their own).
   */
  readonly keyFor: (suffix: string) => string;
  /** TTL in seconds. Defaults to 14 days per the IBX-IGE plan. */
  readonly ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60;

export function createRedisLedger(opts: CreateRedisLedgerOptions): Ledger {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const keyFor = (hash: string) => opts.keyFor(`ledger:intent:${hash}`);

  return {
    async checkLedger(intentHash) {
      const raw = await opts.client.get(keyFor(intentHash));
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          typeof (parsed as LedgerHit).at !== "string"
        ) {
          return null;
        }
        return parsed as LedgerHit;
      } catch {
        return null;
      }
    },

    async recordExecution(entry: LedgerRecordInput) {
      const payload: LedgerHit = {
        resourceVersion: entry.resourceVersion,
        at: new Date().toISOString(),
        sessionId: entry.sessionId,
        kind: entry.kind,
      };
      // SET NX — first writer wins. If the key exists we silently drop the
      // write; the original record remains authoritative.
      await opts.client.set(keyFor(entry.intentHash), JSON.stringify(payload), {
        NX: true,
        EX: ttl,
      });
    },
  };
}
