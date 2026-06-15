// Tests for runner/journey-lock.ts (T1b-7) — per-journey run locks over an
// in-memory Redis mock (Module System rule: no network in unit tests).
//
// Asserted contract:
//   * same-journey contention: fail-fast (acquireTimeoutMs 0) throws
//     JourneyLockTimeoutError while held; a waiter blocks and acquires only
//     AFTER the holder releases (wait-with-timeout policy);
//   * different journey ids never contend (distinct keys);
//   * release is ownership-checked: the Lua conditional DEL only fires for
//     the exact token-bearing value the holder wrote (CLAUDE.md rule 10);
//   * the heartbeat extends the TTL only for the matching owner.
import { describe, it, expect } from "vitest"

import {
  acquireJourneyLock,
  JourneyLockTimeoutError,
  type JourneyLockRedis,
} from "../journey-lock.js"

// ── In-memory Redis mock ─────────────────────────────────────────────────────

interface Entry {
  value: string
  expiresAtMs: number
}

class InMemoryRedis implements JourneyLockRedis {
  readonly store = new Map<string, Entry>()

  /** Live (non-expired) entry, expiring lazily like Redis does. */
  live(key: string): Entry | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (Date.now() >= entry.expiresAtMs) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  async set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<string | null> {
    if (options.NX === true && this.live(key) !== undefined) return null
    this.store.set(key, { value, expiresAtMs: Date.now() + options.EX * 1000 })
    return "OK"
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null
  }

  async eval(
    script: string,
    { keys, arguments: args }: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const key = keys[0]!
    const entry = this.live(key)
    if (script.includes("DEL")) {
      // Conditional release: delete only on full-value match.
      if (entry !== undefined && entry.value === args[0]) {
        this.store.delete(key)
        return 1
      }
      return 0
    }
    if (script.includes("PEXPIRE")) {
      // Conditional heartbeat: extend TTL only on full-value match.
      if (entry !== undefined && entry.value === args[0]) {
        entry.expiresAtMs = Date.now() + Number(args[1])
        return 1
      }
      return 0
    }
    throw new Error(`mock eval: unknown script\n${script}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Fast-feedback options for the contention tests. */
const fast = { pollMs: 10, heartbeatMs: 0 } as const

describe("acquireJourneyLock — same-journey serialization", () => {
  it("fail-fast (acquireTimeoutMs 0): second acquire of the SAME journey throws while held", async () => {
    const redis = new InMemoryRedis()
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
    // ... and succeeds once the holder released.
    const second = await acquireJourneyLock("JOURNEY-001", {
      redis,
      ...fast,
      acquireTimeoutMs: 0,
    })
    expect(second.token).not.toBe(first.token)
    await second.release()
  })

  it("wait-with-timeout: a waiter blocks until the holder releases, then acquires", async () => {
    const redis = new InMemoryRedis()
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
    const stored = await redis.get(handle.key)
    expect(stored).not.toBeNull()
    expect(stored).toContain(handle.token)
    await handle.release()
  })

  it("waiting past the deadline throws JourneyLockTimeoutError", async () => {
    const redis = new InMemoryRedis()
    const holder = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
    await expect(
      acquireJourneyLock("JOURNEY-001", { redis, ...fast, acquireTimeoutMs: 50 }),
    ).rejects.toThrow(JourneyLockTimeoutError)
    await holder.release()
  })
})

describe("acquireJourneyLock — different journeys never serialize", () => {
  it("locks for two journey ids acquire concurrently (distinct keys)", async () => {
    const redis = new InMemoryRedis()
    const a = await acquireJourneyLock("JOURNEY-001", { redis, ...fast, acquireTimeoutMs: 0 })
    // Fail-fast timeout: any cross-journey contention would throw here.
    const b = await acquireJourneyLock("JOURNEY-002", { redis, ...fast, acquireTimeoutMs: 0 })

    expect(a.key).not.toBe(b.key)
    expect(a.key.endsWith("journey:lock:JOURNEY-001")).toBe(true)
    expect(b.key.endsWith("journey:lock:JOURNEY-002")).toBe(true)
    expect(redis.store.size).toBe(2)

    await a.release()
    await b.release()
    expect(redis.store.size).toBe(0)
  })
})

describe("release — ownership-checked conditional DEL", () => {
  it("releases only the exact value it wrote (token match)", async () => {
    const redis = new InMemoryRedis()
    const lock = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
    expect(await redis.get(lock.key)).toContain(lock.token)

    await lock.release()
    expect(await redis.get(lock.key)).toBeNull()
  })

  it("a stale holder's release never deletes another run's lock", async () => {
    const redis = new InMemoryRedis()
    const stale = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })

    // Simulate the stale holder's TTL lapsing and a NEW run taking the key
    // (the exact scenario plain DEL would corrupt).
    redis.store.delete(stale.key)
    const next = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
    expect(next.token).not.toBe(stale.token)

    await stale.release() // conditional DEL — value mismatch, must no-op
    const stored = await redis.get(next.key)
    expect(stored).not.toBeNull()
    expect(stored).toContain(next.token)

    await next.release()
    expect(await redis.get(next.key)).toBeNull()
  })

  it("release is idempotent", async () => {
    const redis = new InMemoryRedis()
    const lock = await acquireJourneyLock("JOURNEY-001", { redis, ...fast })
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
    expect(redis.store.size).toBe(0)
  })
})

describe("heartbeat — owner-checked TTL extension", () => {
  it("extends the TTL while held", async () => {
    const redis = new InMemoryRedis()
    const lock = await acquireJourneyLock("JOURNEY-001", {
      redis,
      pollMs: 10,
      ttlSeconds: 1,
      heartbeatMs: 25,
    })
    const initialExpiry = redis.store.get(lock.key)!.expiresAtMs

    await sleep(200) // several heartbeat ticks
    const extendedExpiry = redis.store.get(lock.key)!.expiresAtMs
    expect(extendedExpiry).toBeGreaterThan(initialExpiry)

    await lock.release() // also clears the heartbeat interval
    expect(await redis.get(lock.key)).toBeNull()
  })

  it("never extends (or releases) a key another run took over after a TTL lapse", async () => {
    const redis = new InMemoryRedis()
    const stale = await acquireJourneyLock("JOURNEY-001", {
      redis,
      pollMs: 10,
      ttlSeconds: 1,
      heartbeatMs: 20,
    })

    // Simulate the takeover: the stale holder's TTL lapsed and a NEW run
    // wrote the key — the old heartbeat must see a value mismatch.
    redis.store.set(stale.key, { value: "next-run-value", expiresAtMs: Date.now() + 60_000 })
    const takeoverExpiry = redis.store.get(stale.key)!.expiresAtMs

    await sleep(150) // several stale-holder heartbeat ticks
    expect(redis.store.get(stale.key)!.expiresAtMs).toBe(takeoverExpiry) // no extension

    await stale.release() // conditional DEL — value mismatch, must no-op
    expect(redis.store.get(stale.key)!.value).toBe("next-run-value")
  })
})
