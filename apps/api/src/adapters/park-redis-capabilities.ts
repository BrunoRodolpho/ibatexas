// F-22 — Redis capabilities are validated at the COMPOSITION ROOT.
//
// # The policy
//
// > Capabilities are validated at composition root. Runtime should never
// > branch based on optional Redis features.
//
// Two sites in this repo used to violate it, in different ways:
//
//   1. `adapters/park-nx.ts` `releaseNxPlaceholder` feature-detected `eval`
//      and, on a miss OR on a throw, fell through to an unconditional `del`.
//      That inverts the compare-and-delete mitigation exactly in the failure
//      mode it was written for — a Redis blip is the most likely cause of
//      BOTH the mid-park throw that reaches the release AND the `EVAL`
//      failing, so the CAD was skipped precisely when a foreign owner may
//      already hold the key. (CLAUDE.md Hard Rule #10.)
//
//   2. `@adjudicate/runtime`'s `parkDeferredIntent` does
//      `typeof args.redis.evalIncrCheck === "function"` and takes a
//      NON-ATOMIC `INCR → EXPIRE → check → DECR` fallback when the member is
//      absent — a documented TOCTOU over-commit window on the per-session
//      DEFER quota. That package is external (pinned npm dep, source of
//      truth is the platform repo) and MUST NOT be edited here.
//
// # The in-repo fix
//
// This module is the composition root for the DEFER park path's Redis
// surface. `createParkRedisCapabilities()` takes a raw client, PROVES it
// carries every command the path's atomicity depends on, and returns a
// `ParkRedisCapabilities` whose atomic members are REQUIRED, not optional.
//
// The consequences are deterministic rather than conditional:
//
//   • `park-nx.ts` calls `redis.compareAndDelete(...)` unconditionally — no
//     detect, and no `del` fallback (see its own header for the failure-mode
//     change).
//   • `evalIncrCheck` is always present on the object handed to
//     `parkDeferredIntent`, so the framework's `typeof … === "function"`
//     probe is deterministically TRUE in this repo and its non-atomic
//     fallback is DEAD CODE here. The probe itself should eventually die
//     platform-side; see the F-22 section of
//     `apps/api/src/__tests__/helpers/redis-double-census.md`.
//
// A client that cannot serve the path fails CLOSED at composition, loudly,
// with the missing command names — it never silently degrades.

import type { ParkRedis } from "@adjudicate/runtime"
import { getRedisClient } from "@ibatexas/tools"

// ── The required-command roll call ───────────────────────────────────────────

/**
 * Commands the DEFER park path requires of the underlying Redis client.
 *
 * HAND-WRITTEN. This constant is documentation + a test anchor; it is NOT the
 * thing that enforces the contract. Enforcement is the explicit per-command
 * roll call inside {@link createParkRedisCapabilities}, so deleting one check
 * deletes exactly one command's coverage and its named unit case reds.
 *
 * `del` is deliberately ABSENT: after F-22 nothing on this path issues an
 * unconditional DEL. The only deletion is the Lua compare-and-delete, which
 * needs `eval`.
 */
export const REQUIRED_PARK_REDIS_COMMANDS = [
  "eval",
  "set",
  "incr",
  "decr",
  "expire",
] as const

export type RequiredParkRedisCommand =
  (typeof REQUIRED_PARK_REDIS_COMMANDS)[number]

// ── Fail-closed sentinel ─────────────────────────────────────────────────────

/**
 * Thrown when composition is handed a Redis client that cannot serve the
 * DEFER park path. Fail-closed: the caller surfaces a refusal (me.ts turns it
 * into a 503 + pt-BR message) rather than parking through a degraded path.
 */
export class RedisCapabilityUnavailableError extends Error {
  readonly name = "RedisCapabilityUnavailableError"
  readonly missing: ReadonlyArray<string>
  constructor(missing: ReadonlyArray<string>) {
    super(
      `createParkRedisCapabilities: refusing to compose the DEFER park Redis ` +
        `surface — the client does not expose [${missing.join(", ")}]. ` +
        `The park path's atomicity (Lua compare-and-delete placeholder release, ` +
        `atomic quota check-and-increment) is NOT an optional feature: a client ` +
        `missing these commands cannot serve it. Fix the composition — never ` +
        `add a runtime feature-detect with a degraded fallback (F-22).`,
    )
    this.missing = missing
  }
}

// ── Lua ──────────────────────────────────────────────────────────────────────

/**
 * Compare-and-delete. Deletes `KEYS[1]` only while its value is still
 * `ARGV[1]`, so a release can never erase a key another owner has since
 * claimed. CLAUDE.md Hard Rule #10; same shape as
 * `packages/tools/src/redis/distributed-lock.ts` `RELEASE_LOCK_SCRIPT` and
 * `apps/api/src/whatsapp/session.ts`.
 */
export const COMPARE_AND_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

/**
 * Atomic check-and-increment for the per-session DEFER quota counter.
 *
 * Byte-for-byte the sequence `@adjudicate/runtime`'s `ParkRedis.evalIncrCheck`
 * doc-comment prescribes: INCR, refresh the TTL, and roll the increment back
 * (returning 0) when the cap is exceeded. Running it as ONE Lua eval closes
 * the framework's documented over-commit race, where two concurrent parks at
 * `quota − 1` both pass before either rolls back.
 */
export const EVAL_INCR_CHECK_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
if tonumber(v) > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return v
`

// ── The capability contract ──────────────────────────────────────────────────

/**
 * The Redis surface the DEFER park path is composed against.
 *
 * Extends the framework's `ParkRedis` and PROMOTES `evalIncrCheck` from
 * optional to REQUIRED, plus adds the atomic release the NX guard needs. The
 * `?` is what let both defects exist; removing it is the fix. A value of this
 * type can only be obtained from {@link createParkRedisCapabilities}, which
 * proves the underlying client can honour it.
 */
export interface ParkRedisCapabilities extends ParkRedis {
  /**
   * REQUIRED (framework declares it optional). Atomic INCR + EXPIRE + cap
   * check in a single round trip. Returns 0 when the cap was exceeded (the
   * increment already rolled back), else the new count.
   */
  evalIncrCheck(
    counterKey: string,
    ttlSeconds: number,
    max: number,
  ): Promise<number>
  /**
   * REQUIRED. Delete `key` only while its value is still `expectedValue`.
   * Returns 1 when deleted, 0 when the value no longer matches (someone else
   * owns the key — leave it alone).
   */
  compareAndDelete(key: string, expectedValue: string): Promise<number>
}

/** The raw client shape this module composes over (node-redis satisfies it). */
interface RedisCommandClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>
  set(
    key: string,
    value: string,
    options: { EX: number },
  ): Promise<string | null>
  incr(key: string): Promise<number>
  decr(key: string): Promise<number>
  expire(key: string, seconds: number, mode?: "NX"): Promise<unknown>
}

// ── Composition ──────────────────────────────────────────────────────────────

/**
 * Compose the validated park Redis surface over a raw client.
 *
 * The per-command checks below are the ONLY legitimate capability probe in
 * this repo, and they are legitimate precisely because their outcome is a
 * THROW — never a behavioural branch. The structural gate
 * (`apps/api/src/__tests__/bypass-detection/redis-capability-detect-conformance.test.ts`)
 * allowlists this file by path and flags every other occurrence.
 *
 * @throws {RedisCapabilityUnavailableError} when any required command is absent.
 */
export function createParkRedisCapabilities(
  client: unknown,
): ParkRedisCapabilities {
  const c = client as RedisCommandClient | null | undefined

  // Hand-written roll call — one line per command in
  // REQUIRED_PARK_REDIS_COMMANDS, each with its own named unit case. NOT a
  // loop over that constant: a derived iteration source would delete a
  // command's coverage the moment the row was deleted (F-14).
  const missing: string[] = []
  if (typeof c?.eval !== "function") missing.push("eval")
  if (typeof c?.set !== "function") missing.push("set")
  if (typeof c?.incr !== "function") missing.push("incr")
  if (typeof c?.decr !== "function") missing.push("decr")
  if (typeof c?.expire !== "function") missing.push("expire")
  if (missing.length > 0) {
    throw new RedisCapabilityUnavailableError(missing)
  }

  const ready = c as RedisCommandClient

  return {
    incr: (key) => ready.incr(key),
    decr: (key) => ready.decr(key),
    expire: (key, seconds, mode) => ready.expire(key, seconds, mode),
    set: (key, value, options) => ready.set(key, value, options),
    async evalIncrCheck(counterKey, ttlSeconds, max) {
      const raw = await ready.eval(EVAL_INCR_CHECK_SCRIPT, {
        keys: [counterKey],
        arguments: [String(ttlSeconds), String(max)],
      })
      return Number(raw)
    },
    async compareAndDelete(key, expectedValue) {
      const raw = await ready.eval(COMPARE_AND_DELETE_SCRIPT, {
        keys: [key],
        arguments: [expectedValue],
      })
      return Number(raw)
    },
  }
}

/**
 * The composition root for the DEFER park path: the ONE place that turns
 * "a Redis client" into "a Redis surface proven able to serve the park path".
 *
 * Every production park call site goes through this. `getRedisClient()` is
 * lazy (it reads REDIS_URL on first call), so validation runs at the first
 * park rather than at process start — but the shape of the failure is the
 * repo's fail-closed boot idiom: a loud throw naming what is missing, and a
 * refusal downstream, never a silent degradation.
 */
export async function getParkRedisCapabilities(): Promise<ParkRedisCapabilities> {
  return createParkRedisCapabilities(await getRedisClient())
}
