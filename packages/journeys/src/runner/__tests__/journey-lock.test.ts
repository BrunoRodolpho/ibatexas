// Tests for runner/journey-lock.ts (T1b-7) — per-journey run locks.
//
// ── M2: the emulation is GONE; this suite runs on a REAL Redis ──────────────
//
// Ruling: docs/architecture/redis-lua-testing-decision.md. Census: class (i),
// item 7 — `apps/api/src/__tests__/helpers/redis-double-census.md`.
//
// This file used to drive an `InMemoryRedis` whose `eval()` re-implemented BOTH
// of journey-lock's Lua scripts in JavaScript, branching on the script text
// (`script.includes("DEL")` / `("PEXPIRE")`). It was the repo's ONLY
// script-DISPATCHING double, and the only class-(i) double whose SUT reaches
// two script shapes (CAD and CAE).
//
// Why that had to go, and why the other six retirements could not use the same
// remedy this one does:
//
//   * The emulation DECIDED the very properties the cases are named after. "a
//     stale holder's release never deletes another run's lock" was true because
//     four lines of JS said `entry.value === args[0]`. If `journey-lock.ts`
//     dropped `== ARGV[1]` tomorrow, this file would not have noticed — the
//     double never read the script it was handed beyond a substring test.
//   * Its dispatch was LOAD-BEARING, not decoration. Hand the heartbeat script
//     to a CAD-shaped double and the heartbeat DELETES the lock; hand the
//     release script to a CONSUME-shaped one and a foreign holder is told
//     "released, here is the value". The census calls this the
//     script-blindness hazard; this file is where it bites hardest.
//   * Unlike the CONSUME call sites, this suite's subject is not "did the site
//     issue the right script" — it is `acquireJourneyLock`'s ORCHESTRATION:
//     contention, polling, the wait deadline, key distinctness, heartbeat
//     liveness. Every one of those needs the release to ACTUALLY free the key,
//     so unit observation cannot carry them. Disposition (c): real Redis.
//
// Where the emulated invariants now live:
//   * CAD — "release deletes only on a full-value match" is
//     `apps/api/src/__tests__/lua-shape-cad-contract.test.ts`, which EVALs
//     THIS FILE'S OWN script text (read from journey-lock.ts) against a
//     container, with a conjunct-removal control.
//   * CAE — "the heartbeat extends only for the owner" is
//     `apps/api/src/__tests__/lua-shape-cae-contract.test.ts`, likewise over
//     this site's bytes, including "a heartbeat that outlives its own lock
//     never keeps the NEW owner's lock alive".
//   Both are enrolled in the M0 loud-skip roll call, and so is this file.
//
// Asserted contract (unchanged in substance — every case kept its name):
//   * same-journey contention: fail-fast (acquireTimeoutMs 0) throws
//     JourneyLockTimeoutError while held; a waiter blocks and acquires only
//     AFTER the holder releases (wait-with-timeout policy);
//   * different journey ids never contend (distinct keys);
//   * release is ownership-checked: the Lua conditional DEL only fires for
//     the exact token-bearing value the holder wrote (CLAUDE.md rule 10);
//   * the heartbeat extends the TTL only for the matching owner.
//
// Local opt-out: IBX_SKIP_REAL_REDIS=1 (the repo-wide convention, mirrored
// from apps/api's harness). CI must run real — `scripts/check-real-redis-suites.mjs`
// reds if this file executes fewer cases than its roll-call entry names.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { GenericContainer, type StartedTestContainer } from "testcontainers"
import { createClient, type RedisClientType } from "redis"

import {
  acquireJourneyLock,
  JourneyLockTimeoutError,
  type JourneyLockRedis,
} from "../journey-lock.js"

/** Repo convention: real infrastructure or no test. Local dev may opt out. */
const RUN_REAL_REDIS = process.env["IBX_SKIP_REAL_REDIS"] !== "1"

/**
 * The SAME three-method narrowing wrapper `journey-lock.ts`'s own
 * `defaultRedis()` builds over the shared client — so these cases drive the
 * production adapter shape, not a bespoke test surface.
 */
function makeJourneyLockRedis(client: RedisClientType): JourneyLockRedis {
  return {
    set: (key, value, options) => client.set(key, value, options),
    get: (key) => client.get(key),
    eval: (script, options) => client.eval(script, options),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Fast-feedback options for the contention tests. */
const fast = { pollMs: 10, heartbeatMs: 0 } as const

describe.skipIf(!RUN_REAL_REDIS)("journey-lock (real Redis)", () => {
  let container: StartedTestContainer
  let client: RedisClientType
  let redis: JourneyLockRedis

  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withStartupTimeout(60_000)
      .start()

    client = createClient({
      url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    }) as RedisClientType
    client.on("error", () => {
      /* swallow — surface errors via the awaited operation instead */
    })
    await client.connect()
    redis = makeJourneyLockRedis(client)
  }, 120_000)

  afterAll(async () => {
    if (client?.isOpen) await client.quit().catch(() => undefined)
    await container?.stop({ remove: true, timeout: 10_000 }).catch(() => undefined)
  })

  beforeEach(async () => {
    await client.flushAll()
  })

  // ── same-journey serialization ────────────────────────────────────────────

  describe("acquireJourneyLock — same-journey serialization", () => {
    it("fail-fast (acquireTimeoutMs 0): second acquire of the SAME journey throws while held", async () => {
      const first = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })

      await expect(
        acquireJourneyLock("JOURNEY-001", { redis, ...fast, acquireTimeoutMs: 0 }),
      ).rejects.toThrow(JourneyLockTimeoutError)
      // The error names the journey and the current holder (pid) — a clear
      // message, never a bare failure.
      await expect(
        acquireJourneyLock("JOURNEY-001", { redis, ...fast, acquireTimeoutMs: 0 }),
      ).rejects.toThrow(/JOURNEY-001.*held by pid \d+/)

      await first.release()
      // ... and succeeds once the holder released. The re-acquire is only
      // possible because the CAD really deleted the key on the server.
      const second = await acquireJourneyLock("JOURNEY-001", {
        redis,
        ...fast,
        acquireTimeoutMs: 0,
      })
      expect(second.token).not.toBe(first.token)
      await second.release()
    })

    it("wait-with-timeout: a waiter blocks until the holder releases, then acquires", async () => {
      const holder = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })

      let waiterDone = false
      const waitLines: string[] = []
      const waiter = acquireJourneyLock("JOURNEY-001", {
        redis,
        ...fast,
        acquireTimeoutMs: 5_000,
        onWait: (line) => waitLines.push(line),
      }).then((handle) => {
        waiterDone = true
        return handle
      })

      await sleep(60) // several poll cycles — the waiter must still be blocked
      expect(waiterDone).toBe(false)
      expect(waitLines).toHaveLength(1) // one-shot contention progress line
      expect(waitLines[0]).toContain("JOURNEY-001")

      await holder.release()
      const handle = await waiter
      expect(waiterDone).toBe(true)
      // The waiter now owns the key with ITS token-bearing value.
      const stored = await client.get(handle.key)
      expect(stored).not.toBeNull()
      expect(stored).toContain(handle.token)
      await handle.release()
    })

    it("waiting past the deadline throws JourneyLockTimeoutError", async () => {
      const holder = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
      await expect(
        acquireJourneyLock("JOURNEY-001", { redis, ...fast, acquireTimeoutMs: 50 }),
      ).rejects.toThrow(JourneyLockTimeoutError)
      await holder.release()
    })
  })

  // ── distinct keys ─────────────────────────────────────────────────────────

  describe("acquireJourneyLock — different journeys never serialize", () => {
    it("locks for two journey ids acquire concurrently (distinct keys)", async () => {
      const a = await acquireJourneyLock("JOURNEY-001", { redis, ...fast, acquireTimeoutMs: 0 })
      // Fail-fast timeout: any cross-journey contention would throw here.
      const b = await acquireJourneyLock("JOURNEY-002", { redis, ...fast, acquireTimeoutMs: 0 })

      expect(a.key).not.toBe(b.key)
      expect(a.key.endsWith("journey:lock:JOURNEY-001")).toBe(true)
      expect(b.key.endsWith("journey:lock:JOURNEY-002")).toBe(true)
      expect(await client.dbSize()).toBe(2)

      await a.release()
      await b.release()
      expect(await client.dbSize()).toBe(0)
    })
  })

  // ── release ───────────────────────────────────────────────────────────────

  describe("release — ownership-checked conditional DEL", () => {
    it("releases only the exact value it wrote (token match)", async () => {
      const lock = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
      expect(await client.get(lock.key)).toContain(lock.token)

      await lock.release()
      expect(await client.get(lock.key)).toBeNull()
    })

    it("a stale holder's release never deletes another run's lock", async () => {
      const stale = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })

      // Simulate the stale holder's TTL lapsing and a NEW run taking the key
      // (the exact scenario plain DEL would corrupt).
      await client.del(stale.key)
      const next = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
      expect(next.token).not.toBe(stale.token)

      await stale.release() // conditional DEL — value mismatch, must no-op
      const stored = await client.get(next.key)
      expect(stored).not.toBeNull()
      expect(stored).toContain(next.token)

      await next.release()
      expect(await client.get(next.key)).toBeNull()
    })

    it("release is idempotent", async () => {
      const lock = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
      await lock.release()
      await expect(lock.release()).resolves.toBeUndefined()
      expect(await client.dbSize()).toBe(0)
    })
  })

  // ── heartbeat ─────────────────────────────────────────────────────────────

  describe("heartbeat — owner-checked TTL extension", () => {
    it("extends the TTL while held", async () => {
      const ttlSeconds = 2
      const lock = await acquireJourneyLock("JOURNEY-001", {
        redis,
        pollMs: 10,
        ttlSeconds,
        heartbeatMs: 25,
      })

      const sleptMs = 400
      await sleep(sleptMs) // many heartbeat ticks

      // Two-sided band. WITHOUT the heartbeat the key would be down to
      // ttl - slept (1600ms at most); WITH it, every tick resets it to the
      // full window, so the remaining TTL must still be near the top of it.
      const remaining = await client.pTTL(lock.key)
      expect(remaining).toBeGreaterThan(ttlSeconds * 1000 - sleptMs)
      expect(remaining).toBeLessThanOrEqual(ttlSeconds * 1000)

      await lock.release() // also clears the heartbeat interval
      expect(await client.get(lock.key)).toBeNull()
    })

    it("never extends (or releases) a key another run took over after a TTL lapse", async () => {
      const stale = await acquireJourneyLock("JOURNEY-001", {
        redis,
        pollMs: 10,
        ttlSeconds: 2,
        heartbeatMs: 20,
      })

      // Simulate the takeover: the stale holder's TTL lapsed and a NEW run
      // wrote the key — the old heartbeat must see a value mismatch.
      await client.set(stale.key, "next-run-value", { PX: 60_000 })
      const afterTakeover = await client.pTTL(stale.key)

      const sleptMs = 150 // several stale-holder heartbeat ticks
      await sleep(sleptMs)

      // A successful foreign PEXPIRE would push the TTL back up to the stale
      // holder's 2s window (or to 60s); a no-op leaves it counting DOWN.
      const remaining = await client.pTTL(stale.key)
      expect(remaining).toBeLessThanOrEqual(afterTakeover - sleptMs + 50)
      expect(remaining).toBeGreaterThan(afterTakeover - sleptMs - 200)

      await stale.release() // conditional DEL — value mismatch, must no-op
      expect(await client.get(stale.key)).toBe("next-run-value")
    })
  })
})
