// runner/journey-lock.ts — per-run journey locks (T1b-7).
//
// Concurrent runs of the SAME journey id serialize; DIFFERENT journeys never
// do. One Redis key per journey id (`journey:lock:<journeyId>` via rk() —
// CLAUDE.md rule 7); the stored value is a JSON blob carrying a fresh UUID
// token per acquisition, released ONLY through an ownership-checked Lua
// conditional DEL (CLAUDE.md rule 10). This mirrors the fixed P0-11 pattern
// in packages/cli/src/lib/lock.ts but is reimplemented here because the
// dependency direction forbids journeys→cli (D-010): journeys may only
// depend on @ibatexas/tools, which supplies the shared client + rk().
//
// Why: a journey run owns shared stack state for its duration — the seeded
// customer row, the hashed(customerId) audit namespace the verify phase
// scopes to (D-012), and scarce budgets like the order-cancel route's
// 5/10min/customer rate limit (D-014). Two interleaved runs of the same
// journey would cross-contaminate reconciliation and burn each other's
// rate-limit budget. Different journeys use different personas/customers,
// so they stay concurrent.
//
// Contention policy (recorded decision): WAIT-WITH-TIMEOUT. The second
// acquirer polls SET NX until the holder releases (or its TTL lapses); past
// the deadline it throws JourneyLockTimeoutError naming the current holder —
// never a silent hang, never an instant hard failure while a legitimate run
// is mid-flight. `acquireTimeoutMs: 0` degrades to fail-fast for callers
// that prefer it.
//
// Liveness: the TTL is a crash safety net (a dead holder frees the journey
// within JOURNEY_LOCK_TTL_SECONDS), and an ownership-checked Lua PEXPIRE
// heartbeat extends it while the run is alive, so a long multi-attempt
// k-loop never loses the lock mid-run.

import { randomUUID } from "node:crypto"
import { getRedisClient, rk } from "@ibatexas/tools"

// ── Contract pins ────────────────────────────────────────────────────────────

/** Per-JOURNEY-id lock key (namespaced by rk() — never raw strings). */
const LOCK_KEY_PREFIX = "journey:lock:"

/** Crash safety net: a dead holder frees the journey within this window. */
export const JOURNEY_LOCK_TTL_SECONDS = 120

/**
 * Wait-with-timeout default: covers one full attempt wall-clock budget
 * (10 min — run-journey-cli's ATTEMPT_TIMEOUT_MS) plus settle slack, so a
 * second run queued behind a single in-flight attempt normally gets through.
 */
export const JOURNEY_LOCK_ACQUIRE_TIMEOUT_MS = 15 * 60 * 1000

/** Contention poll cadence (SET NX retry interval). */
const DEFAULT_POLL_MS = 5_000

/**
 * Lua: conditional DEL — only deletes when the stored value matches ours.
 * Never plain redis.del(): after a TTL lapse another run may hold the key.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

/** Lua: conditional PEXPIRE — heartbeat extends the TTL only for the owner. */
const HEARTBEAT_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`

// ── Contracts ────────────────────────────────────────────────────────────────

/**
 * The slice of the node-redis v4 client the lock needs — injectable so the
 * unit tests run against an in-memory mock (Module System: no network in
 * tests). The default is the shared @ibatexas/tools client (REDIS_URL from
 * the harness env, .env.test).
 */
export interface JourneyLockRedis {
  set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<string | null>
  get(key: string): Promise<string | null>
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>
}

interface JourneyLockHolder {
  journeyId: string
  pid: number
  startedAt: string
}

/**
 * Stored lock value = holder info + a per-acquisition UUID token. The Lua
 * scripts compare the FULL serialized string, so the token makes every
 * acquisition unique — release/heartbeat can only ever act for the exact
 * holder that wrote the value (P0-11 / D-008 pattern).
 */
interface JourneyLockValue extends JourneyLockHolder {
  token: string
}

export interface JourneyLockOptions {
  /** Injected client (tests); defaults to the shared @ibatexas/tools client. */
  redis?: JourneyLockRedis
  /** Lock TTL safety net (default JOURNEY_LOCK_TTL_SECONDS). */
  ttlSeconds?: number
  /**
   * How long a contended acquire waits before throwing
   * JourneyLockTimeoutError (default JOURNEY_LOCK_ACQUIRE_TIMEOUT_MS;
   * 0 = fail fast on first contention).
   */
  acquireTimeoutMs?: number
  /** SET NX retry interval while waiting (default 5s). */
  pollMs?: number
  /**
   * Owner-checked TTL-extension interval (default ttl/3; 0 disables —
   * unit tests that assert pure acquire/release semantics).
   */
  heartbeatMs?: number
  /** One-shot progress line when the acquire first hits contention. */
  onWait?: (line: string) => void
}

export interface JourneyLockHandle {
  /** The rk()-namespaced Redis key (`<env>:journey:lock:<journeyId>`). */
  key: string
  /** This acquisition's UUID — release only fires for this exact holder. */
  token: string
  /** Ownership-checked release. Idempotent; swallows transport errors (TTL net). */
  release: () => Promise<void>
}

/** Thrown when the same journey is still locked past `acquireTimeoutMs`. */
export class JourneyLockTimeoutError extends Error {
  constructor(journeyId: string, holder: string, waitedMs: number) {
    super(
      `journey_lock_timeout: another run of ${journeyId} is in flight (${holder}) — ` +
        `still locked after ${Math.round(waitedMs / 1000)}s; wait for it to finish ` +
        `(crashed holders auto-expire within ${JOURNEY_LOCK_TTL_SECONDS}s) or raise acquireTimeoutMs`,
    )
    this.name = "JourneyLockTimeoutError"
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

async function defaultRedis(): Promise<JourneyLockRedis> {
  // Typed narrowing wrapper over the shared client (the P0-1 idiom) — the
  // lock never sees more of the client surface than the contract above.
  const client = await getRedisClient()
  return {
    set: (key, value, options) => client.set(key, value, options),
    get: (key) => client.get(key),
    eval: (script, options) => client.eval(script, options),
  }
}

async function describeHolder(redis: JourneyLockRedis, key: string): Promise<string> {
  try {
    const raw = await redis.get(key)
    if (raw === null) return "holder just released or expired"
    const info = JSON.parse(raw) as JourneyLockHolder
    const elapsedS = Math.round((Date.now() - new Date(info.startedAt).getTime()) / 1000)
    return `held by pid ${info.pid} since ${info.startedAt} (${elapsedS}s ago)`
  } catch {
    return "holder unreadable"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Acquire the per-journey run lock. Same-journey contention waits (poll
 * SET NX) up to `acquireTimeoutMs`, then throws JourneyLockTimeoutError
 * with the current holder named. Different journey ids use different keys
 * and never contend. Returns a handle whose `release` is the ownership-
 * checked Lua conditional DEL.
 */
export async function acquireJourneyLock(
  journeyId: string,
  opts: JourneyLockOptions = {},
): Promise<JourneyLockHandle> {
  const redis = opts.redis ?? (await defaultRedis())
  const ttlSeconds = opts.ttlSeconds ?? JOURNEY_LOCK_TTL_SECONDS
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? JOURNEY_LOCK_ACQUIRE_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS

  const key = rk(`${LOCK_KEY_PREFIX}${journeyId}`)
  const value: JourneyLockValue = {
    journeyId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  }
  const serialized = JSON.stringify(value)

  const deadline = Date.now() + acquireTimeoutMs
  let warned = false
  for (;;) {
    // Atomic acquire — NX closes the GET-then-SET TOCTOU window.
    const acquired = await redis.set(key, serialized, { NX: true, EX: ttlSeconds })
    if (acquired === "OK") break

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new JourneyLockTimeoutError(
        journeyId,
        await describeHolder(redis, key),
        acquireTimeoutMs,
      )
    }
    if (!warned) {
      warned = true
      opts.onWait?.(
        `journey lock: ${journeyId} ${await describeHolder(redis, key)} — ` +
          `waiting up to ${Math.round(remainingMs / 1000)}s for it to release`,
      )
    }
    await sleep(Math.min(pollMs, remainingMs))
  }

  // Heartbeat: owner-checked TTL extension while the run is alive. unref'd —
  // it must never keep the process open; release clears it.
  const heartbeatMs =
    opts.heartbeatMs ?? Math.max(1_000, Math.floor((ttlSeconds * 1000) / 3))
  let heartbeat: ReturnType<typeof setInterval> | undefined
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      void redis
        .eval(HEARTBEAT_SCRIPT, {
          keys: [key],
          arguments: [serialized, String(ttlSeconds * 1000)],
        })
        .catch(() => undefined) // transient Redis blips — TTL is the net
    }, heartbeatMs)
    ;(heartbeat as unknown as { unref?: () => void }).unref?.()
  }

  let released = false
  return {
    key,
    token: value.token,
    release: async () => {
      if (released) return
      released = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      try {
        await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [serialized] })
      } catch {
        // Redis unreachable — the TTL safety net frees the lock.
      }
    },
  }
}
