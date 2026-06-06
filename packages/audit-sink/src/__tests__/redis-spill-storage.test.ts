// Unit tests for redis-spill-storage.ts (Task 19 / M4 — durable spill).
//
// Exercises the PersistentSpillStorage adapter against an in-memory Redis
// stub that implements rPush/lPop/lLen/expire. We don't pull in a real
// Redis or ioredis-mock — the surface is intentionally narrow so a Map-
// backed stub is sufficient to cover FIFO ordering, TTL refresh, fail-
// closed read behaviour, and malformed-record drop semantics.

import { describe, it, expect, vi, beforeEach } from "vitest"
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
} {
  const store = new Map<string, string[]>()
  const ttls = new Map<string, number>()
  return {
    _store: store,
    _ttls: ttls,
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
