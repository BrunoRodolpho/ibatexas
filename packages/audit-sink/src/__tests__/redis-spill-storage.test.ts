// Unit tests for redis-spill-storage.ts (Task 19 / M4 — durable spill).
//
// Exercises the PersistentSpillStorage adapter against an in-memory Redis
// stub that implements rPush/lPop/lLen/expire. We don't pull in a real
// Redis or ioredis-mock — the surface is intentionally narrow so a Map-
// backed stub is sufficient to cover FIFO ordering, TTL refresh, fail-
// closed read behaviour, and malformed-record drop semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildAuditRecord, buildEnvelope } from "@adjudicate/core"
import type { AuditRecord } from "@adjudicate/core"

// `redis-spill-storage.ts` inlines `rk` (leaf-purity invariant — it does NOT
// import `@ibatexas/tools`), so a `vi.mock("@ibatexas/tools")` here would be
// inert. The `test:` key prefix the assertions below expect comes from the
// real inlined `rk` reading `APP_ENV=test`, which is pinned in
// `vitest.config.ts`.

import {
  createRedisSpillStorage,
  getRedisSpillSize,
  type RedisListClient,
} from "../redis-spill-storage.js"

// ── Redis stub ─────────────────────────────────────────────────────────────

function makeRedisStub(): RedisListClient & {
  _store: Map<string, string[]>
  _ttls: Map<string, number>
  /** Every key LLEN was called with, in order — the F-23 call-time probe. */
  _lLenCalls: string[]
} {
  const store = new Map<string, string[]>()
  const ttls = new Map<string, number>()
  const lLenCalls: string[] = []
  return {
    _store: store,
    _ttls: ttls,
    _lLenCalls: lLenCalls,
    async rPush(key, value) {
      const list = store.get(key) ?? []
      list.push(value)
      store.set(key, list)
      return list.length
    },
    async lPop(key) {
      const list = store.get(key)
      if (!list || list.length === 0) return null
      return list.shift() ?? null
    },
    async lLen(key) {
      lLenCalls.push(key)
      return store.get(key)?.length ?? 0
    },
    async expire(key, seconds) {
      ttls.set(key, seconds)
      return 1
    },
  }
}

// ── Fixture builder ────────────────────────────────────────────────────────

function makeRecord(index: number): AuditRecord {
  const env = buildEnvelope({
    kind: "customer.profile.update",
    payload: { id: `cust_${index}` },
    actor: { principal: "user", sessionId: `sess_${index}` },
    taint: "TRUSTED",
    nonce: `n_${index}`,
    createdAt: "2026-04-23T00:00:00.000Z",
  })
  return buildAuditRecord({
    envelope: env,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
    at: `2026-04-23T00:00:0${index}.000Z`,
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("createRedisSpillStorage", () => {
  let redis: ReturnType<typeof makeRedisStub>

  beforeEach(() => {
    redis = makeRedisStub()
  })

  it("appends serialized AuditRecord to rk-prefixed queue key", async () => {
    const storage = createRedisSpillStorage({ redis })
    const r = makeRecord(1)
    await storage.append(r)
    expect(redis._store.get("test:audit:spill:queue")).toHaveLength(1)
    const stored = JSON.parse(redis._store.get("test:audit:spill:queue")![0]!)
    expect(stored.intentHash).toBe(r.intentHash)
    expect(stored.envelope.kind).toBe("customer.profile.update")
  })

  it("sets TTL on every append (default 7 days)", async () => {
    const storage = createRedisSpillStorage({ redis })
    await storage.append(makeRecord(1))
    expect(redis._ttls.get("test:audit:spill:queue")).toBe(604_800)
    await storage.append(makeRecord(2))
    // TTL is reset on each append — same value, but the call happened.
    expect(redis._ttls.get("test:audit:spill:queue")).toBe(604_800)
  })

  it("honours custom ttlSeconds", async () => {
    const storage = createRedisSpillStorage({
      redis,
      ttlSeconds: 60,
    })
    await storage.append(makeRecord(1))
    expect(redis._ttls.get("test:audit:spill:queue")).toBe(60)
  })

  it("honours custom keyPrefix (still rk-prefixed)", async () => {
    const storage = createRedisSpillStorage({
      redis,
      keyPrefix: "custom:prefix",
    })
    await storage.append(makeRecord(1))
    expect(redis._store.has("test:custom:prefix:queue")).toBe(true)
  })

  it("drain yields records in FIFO order then stops", async () => {
    const storage = createRedisSpillStorage({ redis })
    for (let i = 1; i <= 3; i++) await storage.append(makeRecord(i))
    const yielded: AuditRecord[] = []
    for await (const r of storage.readAll()) yielded.push(r)
    expect(yielded.map((r) => r.envelope.actor.sessionId)).toEqual([
      "sess_1",
      "sess_2",
      "sess_3",
    ])
    // List drained completely.
    expect(await getRedisSpillSize({ redis })).toBe(0)
  })

  it("drain stops cleanly when queue is empty from the start", async () => {
    const storage = createRedisSpillStorage({ redis })
    const yielded: AuditRecord[] = []
    for await (const r of storage.readAll()) yielded.push(r)
    expect(yielded).toEqual([])
  })

  it("drops malformed JSON entries with a warn callback", async () => {
    const warn = vi.fn()
    const storage = createRedisSpillStorage({ redis, warn })
    // Pre-populate the queue with one valid + one malformed entry.
    await redis.rPush("test:audit:spill:queue", "{not-json")
    await storage.append(makeRecord(1))
    const yielded: AuditRecord[] = []
    for await (const r of storage.readAll()) yielded.push(r)
    expect(yielded).toHaveLength(1)
    expect(yielded[0]!.envelope.actor.sessionId).toBe("sess_1")
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]![0]).toContain("malformed spill entry")
  })

  it("stops drain on LPOP failure but leaves remaining entries intact", async () => {
    const warn = vi.fn()
    const failingRedis: RedisListClient = {
      ...redis,
      async lPop() {
        throw new Error("redis down")
      },
    }
    const storage = createRedisSpillStorage({ redis: failingRedis, warn })
    const yielded: AuditRecord[] = []
    for await (const r of storage.readAll()) yielded.push(r)
    expect(yielded).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]![0]).toContain("LPOP failed")
  })

  it("ack is a no-op (LPOP already removed the record)", async () => {
    const storage = createRedisSpillStorage({ redis })
    const r = makeRecord(1)
    await storage.append(r)
    // Drain once.
    for await (const _ of storage.readAll()) void _
    // Calling ack on a record should not throw, no matter what.
    await expect(storage.ack(r)).resolves.toBeUndefined()
  })

  it("swallows EXPIRE failures but logs (data already pushed)", async () => {
    const warn = vi.fn()
    const flakyRedis: RedisListClient = {
      ...redis,
      async expire() {
        throw new Error("expire down")
      },
    }
    const storage = createRedisSpillStorage({ redis: flakyRedis, warn })
    // append must still succeed because the data IS already in Redis.
    await expect(storage.append(makeRecord(1))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]![0]).toContain("EXPIRE failed")
  })

  it("getRedisSpillSize reports current backlog size", async () => {
    const storage = createRedisSpillStorage({ redis })
    expect(await getRedisSpillSize({ redis })).toBe(0)
    await storage.append(makeRecord(1))
    await storage.append(makeRecord(2))
    expect(await getRedisSpillSize({ redis })).toBe(2)
  })
})

// ── F-23: the inlined `rk` reads APP_ENV at CALL time ──────────────────────
//
// The leaf's header asserts its inlined `rk` mirrors the canonical
// `packages/tools/src/redis/key.ts`. On the capture-time axis that was FALSE
// until F-23: the leaf froze `process.env.APP_ENV` into a module-level const
// at import, which is precisely the pattern FE-D26 abolished from the
// canonical implementation.
//
// This cannot be pinned by importing the canonical `rk` and comparing:
// `@ibatexas/tools` depends on `@ibatexas/audit-sink`, so declaring it here
// — devDependency included — is a hard cycle (`turbo build` errors with
// "Cyclic dependency detected: @ibatexas/tools#build,
// @ibatexas/audit-sink#build"; measured, not assumed). So the PROPERTY is
// pinned directly: set APP_ENV, build a key, change APP_ENV, build another,
// and require the prefix to have moved.
//
// Revert-to-red for these two tests is the module-load capture itself —
// restore `const RK_ENV_PREFIX = process.env.APP_ENV ?? "development"` and
// `return `${RK_ENV_PREFIX}:${key}`` in redis-spill-storage.ts and both go
// red, because the second read cannot see the mutated APP_ENV.
//
// `vitest.config.ts` pins APP_ENV="test" for this package, so these tests
// save and restore it rather than assuming it is unset.

describe("inlined rk (F-23)", () => {
  const original = process.env.APP_ENV

  afterEach(() => {
    if (original === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = original
  })

  it("reads APP_ENV at CALL time, not at module load (getRedisSpillSize)", async () => {
    // `getRedisSpillSize` calls the inlined `rk` on every invocation, so it
    // is the narrowest probe of the read itself — no factory in between.
    const redis = makeRedisStub()

    process.env.APP_ENV = "f23-alpha"
    await getRedisSpillSize({ redis })

    process.env.APP_ENV = "f23-beta"
    await getRedisSpillSize({ redis })

    // Both prefixes must appear, in order: the second call read the NEW
    // APP_ENV. An exact `toEqual` on the recorded call list — not a
    // `toContain` — so a stale first key cannot hide behind a fresh second
    // one, and so the assertion cannot pass on an empty probe.
    expect(redis._lLenCalls).toEqual([
      "f23-alpha:audit:spill:queue",
      "f23-beta:audit:spill:queue",
    ])
  })

  it("reads APP_ENV at CALL time, not at module load (createRedisSpillStorage)", async () => {
    // The factory resolves its queue key once, at construction. Two
    // factories built under two different APP_ENVs must therefore write to
    // two different namespaces — under a module-load capture both would
    // write to whichever value APP_ENV held at import.
    const redis = makeRedisStub()

    process.env.APP_ENV = "f23-alpha"
    await createRedisSpillStorage({ redis }).append(makeRecord(1))

    process.env.APP_ENV = "f23-beta"
    await createRedisSpillStorage({ redis }).append(makeRecord(2))

    expect([...redis._store.keys()].sort()).toEqual([
      "f23-alpha:audit:spill:queue",
      "f23-beta:audit:spill:queue",
    ])
  })

  it("produces the SAME key as the module-load capture when APP_ENV is stable", async () => {
    // The constraint on the F-23 fix: a semantics fix at the edges, NOT a key
    // change. For any process whose APP_ENV is set before the first call and
    // never mutated — every real deployment, and this package's own vitest
    // run, which pins APP_ENV="test" in vitest.config.ts — the lazy read
    // returns exactly what the module-load capture returned.
    //
    // Stability is modelled by NOT touching APP_ENV: the ambient value here
    // IS the value that was live at module load. The expectation is a
    // LITERAL, not `${process.env.APP_ENV}:...` — deriving it from the same
    // source the SUT reads would make it pass under any implementation and
    // prove nothing about the key.
    //
    // Unlike the two tests above, this one is GREEN under both
    // implementations by design. That is the claim: no key moved. The other
    // direction of this proof is that every pre-F-23 assertion in this file
    // still expects "test:audit:spill:queue" and still passes, unedited.
    const redis = makeRedisStub()

    await createRedisSpillStorage({ redis }).append(makeRecord(1))
    await getRedisSpillSize({ redis })

    expect([...redis._store.keys()]).toEqual(["test:audit:spill:queue"])
    expect(redis._lLenCalls).toEqual(["test:audit:spill:queue"])
  })
})
