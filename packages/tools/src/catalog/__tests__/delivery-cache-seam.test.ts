// R5-S6 — the @ibatexas/tools Redis client seam, and the canonical adapter.
//
// Two halves:
//
//   (1) THE ADAPTER (`src/testing/in-memory-redis.ts`) — that it is never
//       benign-empty. Every unrouted command, unsupported option and malformed
//       argument THROWS, and it throws on an EMPTY store, which is where the
//       first draft of this class of double goes wrong: validating while
//       walking the keyspace makes every check vacuous in exactly the state
//       most tests start in. The W4 RULE 3 refusals are pinned verbatim.
//
//   (2) THE SEAM (`estimateDelivery` / `invalidateDeliveryCache`) — that an
//       injected client is what the module actually reads and writes, that the
//       default is still the package singleton, and that `rk()` runs REAL
//       through it so the keys under assertion are the ones production writes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createInMemoryRedis,
  LuaAtomicityNotEmulated,
  NotAnIntegerError,
  UnroutedRedisCall,
  WrongTypeError,
} from "../../testing/in-memory-redis.js"
import { rk } from "../../redis/key.js"

// The two NON-Redis edges of estimateDelivery: the zone projection (Prisma —
// R5-S1's seam, not this one) and the ViaCEP existence probe.
const mockFindActiveByPrefix = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    findActiveByPrefix: mockFindActiveByPrefix,
    findActiveWithCoords: async () => [],
    listAll: async () => [],
  }),
}))

// Imported AFTER the mock so the module under test binds the stubbed service.
const { estimateDelivery, invalidateDeliveryCache } = await import("../estimate-delivery.js")

/** Untyped view of the double — the adapter's job is to throw on these. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = (c: unknown): any => c as any

const originalAppEnv = process.env.APP_ENV

beforeEach(() => {
  process.env.APP_ENV = "test"
  mockFindActiveByPrefix.mockReset()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ cep: "14815-000" }), { status: 200 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalAppEnv === undefined) delete process.env.APP_ENV
  else process.env.APP_ENV = originalAppEnv
})

// ── (1) The adapter is never benign-empty ────────────────────────────────────

describe("in-memory-redis — throw-on-unrouted", () => {
  it("throws on a command it does not implement, naming the command", () => {
    const redis = createInMemoryRedis()
    expect(() => loose(redis.client).hRandField).toThrow(UnroutedRedisCall)
    expect(() => loose(redis.client).hRandField).toThrow(/unrouted call: hRandField/)
    // The message points at the file to extend, not at the code under test.
    expect(() => loose(redis.client).bitCount).toThrow(
      /packages\/tools\/src\/testing\/in-memory-redis\.ts/,
    )
  })

  it("throws on an option it does not model rather than silently dropping it", async () => {
    const redis = createInMemoryRedis()
    await expect(redis.client.set("k", "v", { KEEPTTL: true })).rejects.toThrow(UnroutedRedisCall)
    await expect(redis.client.set("k", "v", { KEEPTTL: true })).rejects.toThrow(
      /unsupported option "KEEPTTL"/,
    )
    // A dropped option is the failure mode that matters: the key must not exist.
    expect(redis.keys()).toEqual([])
  })

  it("answers `then` with undefined so awaiting it is not mistaken for a Redis failure", async () => {
    // Regression pin. `resolveCacheClient` is `async`, so the runtime reads
    // `.then` on whatever it resolves to; when the proxy THREW there, the
    // module's own try/catch swallowed it and every injected path silently
    // behaved like a dead Redis — a green test proving nothing.
    const redis = createInMemoryRedis()
    expect(loose(redis.client).then).toBeUndefined()

    const resolved = await (async () => redis.client)()
    expect(await resolved.get("test:absent")).toBeNull()
  })

  it("mirrors real Redis on a type collision instead of inventing a softer answer", async () => {
    const redis = createInMemoryRedis({ seed: { "test:a-string": "v" } })
    await expect(redis.client.hGetAll("test:a-string")).rejects.toThrow(WrongTypeError)
    await expect(redis.client.hGetAll("test:a-string")).rejects.toThrow(/WRONGTYPE/)
  })

  it("mirrors real Redis on INCR against a non-numeric value", async () => {
    const redis = createInMemoryRedis({ seed: { "test:word": "banana" } })
    await expect(redis.client.incr("test:word")).rejects.toThrow(NotAnIntegerError)
  })
})

// ── (1b) THE VACUITY PIN — validation must precede keyspace access ───────────

describe("in-memory-redis — argument validation runs on an EMPTY store", () => {
  // If validation ran while walking the keyspace, every one of these would
  // return a benign null/0/[] instead of throwing, because there is nothing to
  // walk. An empty store is the state most tests start in, so a check that is
  // vacuous here is vacuous almost everywhere.
  let redis: ReturnType<typeof createInMemoryRedis>

  beforeEach(() => {
    redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
  })

  it("rejects a non-string key", async () => {
    await expect(loose(redis.client).get(42)).rejects.toThrow(/key must be a string/)
    await expect(loose(redis.client).get("")).rejects.toThrow(/key must not be empty/)
  })

  it("rejects a non-string value", async () => {
    await expect(loose(redis.client).set("k", { a: 1 })).rejects.toThrow(
      /value must be a string or number/,
    )
  })

  it("rejects a non-positive or non-integer TTL", async () => {
    await expect(redis.client.set("k", "v", { EX: 0 })).rejects.toThrow(/TTL must be a positive/)
    await expect(redis.client.set("k", "v", { EX: -5 })).rejects.toThrow(/TTL must be a positive/)
    await expect(redis.client.set("k", "v", { EX: 1.5 })).rejects.toThrow(/TTL must be a positive/)
    await expect(redis.client.expire("k", 0)).rejects.toThrow(/TTL must be a positive/)
  })

  it("rejects mutually exclusive SET flags", async () => {
    // Driven through the untyped view on purpose: node-redis' own `SetOptions`
    // already makes EX+PX and NX+XX unrepresentable, so these guards exist for
    // callers that reach the client through a cast or from plain JS.
    await expect(loose(redis.client).set("k", "v", { EX: 10, PX: 10 })).rejects.toThrow(
      /mutually exclusive/,
    )
    await expect(loose(redis.client).set("k", "v", { NX: true, XX: true })).rejects.toThrow(
      /mutually exclusive/,
    )
  })

  it("rejects a malformed SCAN cursor, MATCH and COUNT", async () => {
    await expect(loose(redis.client).scan("0")).rejects.toThrow(/cursor must be a non-negative/)
    await expect(redis.client.scan(-1)).rejects.toThrow(/cursor must be a non-negative/)
    await expect(loose(redis.client).scan(0, { MATCH: 7 })).rejects.toThrow(
      /MATCH must be a string/,
    )
    await expect(redis.client.scan(0, { COUNT: 0 })).rejects.toThrow(/COUNT must be a positive/)
    // A cursor this client never issued is a caller bug, not an empty result.
    await expect(redis.client.scan(999)).rejects.toThrow(/unknown cursor 999/)
  })

  it("rejects empty key/member/field lists", async () => {
    await expect(redis.client.del([])).rejects.toThrow(/requires at least one key/)
    await expect(redis.client.hDel("k", [])).rejects.toThrow(/requires at least one field/)
    await expect(redis.client.sAdd("k", [])).rejects.toThrow(/requires at least one member/)
    await expect(redis.client.zAdd("k", [])).rejects.toThrow(/requires at least one member/)
  })

  it("rejects a malformed zAdd member", async () => {
    await expect(loose(redis.client).zAdd("k", { value: "v" })).rejects.toThrow(
      /score must be a finite number/,
    )
  })

  it("still answers a WELL-FORMED call benignly (the checks are not blanket refusals)", async () => {
    // The complement of the pin: an empty store must still behave like an empty
    // Redis for calls that ARE valid, or the throws above would prove nothing
    // beyond "this adapter refuses everything".
    expect(await redis.client.get("test:absent")).toBeNull()
    expect(await redis.client.del("test:absent")).toBe(0)
    expect(await redis.client.exists("test:absent")).toBe(0)
    expect(await redis.client.hGetAll("test:absent")).toEqual({})
    expect(await redis.client.sMembers("test:absent")).toEqual([])
    expect(await redis.client.scan(0)).toEqual({ cursor: 0, keys: [] })
    expect(await redis.client.ttl("test:absent")).toBe(-2)
  })
})

// ── (1c) W4 RULE 3 — the deliberate refusals ─────────────────────────────────

describe("in-memory-redis — W4 RULE 3 atomicity refusals", () => {
  it("refuses EVAL, naming the rule and the honest home", () => {
    const redis = createInMemoryRedis()
    expect(() =>
      loose(redis.client).eval("return 1", { keys: ["k"], arguments: ["v"] }),
    ).toThrow(LuaAtomicityNotEmulated)
    expect(() =>
      loose(redis.client).eval("return 1", { keys: ["k"], arguments: ["v"] }),
    ).toThrow(
      /eval is deliberately NOT emulated \(W4 RULE 3\).*apps\/api\/src\/__tests__\/helpers\/redis-testcontainer\.ts/s,
    )
  })

  it("refuses evalSha and the MULTI/EXEC transaction commands too", () => {
    const redis = createInMemoryRedis()
    for (const command of ["evalSha", "multi", "exec", "watch", "scriptLoad"]) {
      expect(() => loose(redis.client)[command]()).toThrow(LuaAtomicityNotEmulated)
      expect(() => loose(redis.client)[command]()).toThrow(new RegExp(`${command} is deliberately NOT emulated`))
    }
  })
})

// ── (1d) Semantics the seam depends on ───────────────────────────────────────

describe("in-memory-redis — TTL and SCAN semantics", () => {
  it("expires lazily against an injected clock", async () => {
    let clock = 1_000_000
    const redis = createInMemoryRedis({ now: () => clock })
    await redis.client.set("test:k", "v", { EX: 60 })

    expect(await redis.client.get("test:k")).toBe("v")
    expect(await redis.client.ttl("test:k")).toBe(60)

    clock += 59_000
    expect(await redis.client.get("test:k")).toBe("v")

    clock += 2_000
    expect(await redis.client.get("test:k")).toBeNull()
    expect(redis.keys()).toEqual([])
  })

  it("honours SET NX against a live key and again once it has expired", async () => {
    let clock = 0
    const redis = createInMemoryRedis({ now: () => clock })
    expect(await redis.client.set("test:lock", "a", { NX: true, EX: 10 })).toBe("OK")
    expect(await redis.client.set("test:lock", "b", { NX: true, EX: 10 })).toBeNull()
    clock += 11_000
    expect(await redis.client.set("test:lock", "c", { NX: true, EX: 10 })).toBe("OK")
    expect(redis.peek("test:lock")).toBe("c")
  })

  it("SCAN walks the whole keyspace across cursors and skips nothing under delete-as-you-go", async () => {
    const redis = createInMemoryRedis()
    for (let i = 0; i < 25; i++) {
      await redis.client.set(`test:delivery:cep:1481500${i}`, "x")
    }
    await redis.client.set("test:unrelated", "keep")

    // The exact loop invalidateDeliveryCache runs, with a COUNT that forces
    // several round trips. An offset-based cursor would skip keys here, because
    // the list shrinks under the iteration.
    const seen: string[] = []
    let cursor = 0
    do {
      const res = await redis.client.scan(cursor, { MATCH: "test:delivery:cep:*", COUNT: 4 })
      cursor = res.cursor
      seen.push(...res.keys)
      if (res.keys.length > 0) await redis.client.del(res.keys)
    } while (cursor !== 0)

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
    expect(redis.keys()).toEqual(["test:unrelated"])
  })

  it("MATCH is a real glob — a non-matching key is never returned", async () => {
    const redis = createInMemoryRedis({
      seed: { "test:delivery:cep:1": "a", "test:delivery:zone:1": "b", "prod:delivery:cep:1": "c" },
    })
    const res = await redis.client.scan(0, { MATCH: "test:delivery:cep:*", COUNT: 100 })
    expect(res).toEqual({ cursor: 0, keys: ["test:delivery:cep:1"] })
  })
})

// ── (2) The seam ─────────────────────────────────────────────────────────────

describe("R5-S6 — invalidateDeliveryCache drives the INJECTED client", () => {
  it("deletes exactly the rk()-prefixed delivery keys and leaves everything else", async () => {
    const redis = createInMemoryRedis({
      seed: {
        // Keys written through the REAL rk() with APP_ENV=test — the prefix
        // production writes, not a test-local fiction.
        [rk("delivery:cep:14815000")]: '{"success":true}',
        [rk("delivery:cep:01001000")]: '{"success":false}',
        [rk("cart:active:session:s1")]: "cart_1",
        // A neighbouring environment's key: proof the prefix is load-bearing.
        "production:delivery:cep:14815000": '{"success":true}',
      },
    })
    expect(rk("delivery:cep:14815000")).toBe("test:delivery:cep:14815000")

    await invalidateDeliveryCache({ client: redis.client })

    expect(redis.keys()).toEqual([
      "production:delivery:cep:14815000",
      "test:cart:active:session:s1",
    ])
    // It really went through SCAN + DEL, not some other path.
    expect(redis.calls.map((c) => c.command)).toContain("scan")
    expect(redis.calls.map((c) => c.command)).toContain("del")
  })

  it("is a no-op on an empty keyspace and issues no DEL", async () => {
    const redis = createInMemoryRedis()
    await invalidateDeliveryCache({ client: redis.client })
    expect(redis.keys()).toEqual([])
    expect(redis.calls.filter((c) => c.command === "del")).toHaveLength(0)
  })
})

describe("R5-S6 — estimateDelivery reads and writes the INJECTED client", () => {
  it("serves a cache HIT from the injected keyspace without consulting the zone rows", async () => {
    const cached = {
      success: true,
      cep: "14815000",
      zoneName: "Ibaté",
      feeInCentavos: 1500,
      estimatedMinutes: 50,
      message: "cached",
    }
    const redis = createInMemoryRedis({
      seed: { [rk("delivery:cep:14815000")]: JSON.stringify(cached) },
    })

    const out = await estimateDelivery({ cep: "14815000" }, { client: redis.client })

    expect(out).toEqual(cached)
    // A hit must short-circuit the projection AND the ViaCEP probe.
    expect(mockFindActiveByPrefix).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("writes the MISS result back under the real rk() key, with the configured TTL", async () => {
    mockFindActiveByPrefix.mockResolvedValue({
      name: "Ibaté",
      feeInCentavos: 1500,
      estimatedMinutes: 50,
    })
    const redis = createInMemoryRedis()

    const out = await estimateDelivery({ cep: "14815-000" }, { client: redis.client })
    expect(out.success).toBe(true)
    expect(out.feeInCentavos).toBe(1500)

    // `void cacheDeliveryResult(...)` is deliberately not awaited by the module.
    await vi.waitFor(() => expect(redis.keys()).toContain(rk("delivery:cep:14815000")))

    const stored = JSON.parse(redis.peek(rk("delivery:cep:14815000"))!) as { zoneName: string }
    expect(stored.zoneName).toBe("Ibaté")
    // 1h default (DELIVERY_CACHE_TTL) — a cache entry with no TTL would be a leak.
    expect(redis.ttlMs(rk("delivery:cep:14815000"))).toBeGreaterThan(0)
  })

  it("a fresh keyspace is a MISS — the hit above was the injected data, not a default", async () => {
    // Without this, the hit test would also pass against a double that returns a
    // canned answer for every key.
    mockFindActiveByPrefix.mockResolvedValue(null)
    const redis = createInMemoryRedis()

    const out = await estimateDelivery({ cep: "14815000" }, { client: redis.client })

    expect(out.success).toBe(false)
    expect(mockFindActiveByPrefix).toHaveBeenCalledOnce()
  })

  it("never reaches Redis on the arms that do not cache (no client required)", async () => {
    // The zone-listing arm takes no CEP and caches nothing. Passing a client
    // that would THROW on any command proves the arm is Redis-free — and proves
    // the seam did not hoist client resolution to the entry point.
    const redis = createInMemoryRedis()
    const out = await estimateDelivery({}, { client: redis.client })
    expect(out.success).toBe(false)
    expect(redis.calls).toHaveLength(0)
  })

  it("an invalid CEP is rejected before any Redis touch", async () => {
    const redis = createInMemoryRedis()
    const out = await estimateDelivery({ cep: "123" }, { client: redis.client })
    expect(out.message).toBe("CEP inválido. Informe 8 dígitos numéricos.")
    expect(redis.calls).toHaveLength(0)
  })
})

// ── R5-S7 — the commands the first apps/api consumers issue ──────────────────

describe("in-memory-redis — scanIterator", () => {
  it("VALIDATES AT CALL TIME, not at first iteration", () => {
    const redis = createInMemoryRedis({ seed: { "a:1": "x" } })
    // The trap this pins: written as an `async function*`, the body would not
    // run until the first `next()`, so this call would return a perfectly happy
    // generator and the malformed MATCH would never surface for a caller that
    // builds the iterator and abandons it. NOTHING is iterated here.
    expect(() => loose(redis.client).scanIterator({ MATCH: 5 })).toThrow(UnroutedRedisCall)
    expect(() => loose(redis.client).scanIterator({ MATCH: 5 })).toThrow(/MATCH must be a string/)
    expect(() => loose(redis.client).scanIterator({ COUNT: 0 })).toThrow(
      /COUNT must be a positive integer/,
    )
    expect(() => loose(redis.client).scanIterator({ NOPE: 1 })).toThrow(/unsupported option "NOPE"/)
  })

  it("validates on an EMPTY store (the check is not vacuous where tests start)", () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    expect(() => loose(redis.client).scanIterator({ MATCH: 5 })).toThrow(UnroutedRedisCall)
  })

  it("yields only MATCH-passing keys", async () => {
    const redis = createInMemoryRedis({
      seed: { "test:dlq:a": "1", "test:dlq:b": "2", "test:outbox:c": "3" },
    })
    const seen: string[] = []
    for await (const key of redis.client.scanIterator({ MATCH: "test:dlq:*", COUNT: 10 })) {
      seen.push(key)
    }
    expect(seen.sort()).toEqual(["test:dlq:a", "test:dlq:b"])
  })

  it("never hands back a key deleted mid-iteration (the scan-then-DELETE guarantee)", async () => {
    const redis = createInMemoryRedis({
      seed: { "k:1": "a", "k:2": "b", "k:3": "c", "k:4": "d" },
    })
    const seen: string[] = []
    for await (const key of redis.client.scanIterator({ MATCH: "k:*", COUNT: 2 })) {
      seen.push(key)
      // Delete a key the iterator has not reached yet — the caller pattern that
      // makes an offset cursor silently skip entries.
      if (seen.length === 1) await redis.client.del("k:4")
    }
    expect(seen).not.toContain("k:4")
    expect(seen.sort()).toEqual(["k:1", "k:2", "k:3"])
  })

  it("an expired key is not yielded", async () => {
    let now = 1_000
    const redis = createInMemoryRedis({ now: () => now })
    await redis.client.set("t:live", "a")
    await redis.client.set("t:doomed", "b", { EX: 5 })
    now += 6_000
    const seen: string[] = []
    for await (const key of redis.client.scanIterator({ MATCH: "t:*" })) seen.push(key)
    expect(seen).toEqual(["t:live"])
  })
})

describe("in-memory-redis — lists (lPush / lLen)", () => {
  it("lLen is 0 for an absent list and counts what lPush added", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.lLen("dlq:x")).toBe(0)
    expect(await redis.client.lPush("dlq:x", "one")).toBe(1)
    expect(await redis.client.lPush("dlq:x", "two")).toBe(2)
    expect(await redis.client.lLen("dlq:x")).toBe(2)
  })

  it("lPush prepends, and a multi-value push lands reversed (real LPUSH)", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.lPush("l", ["a", "b", "c"])).toBe(3)
    // LPUSH a b c pushes each in turn onto the head → head is "c".
    expect(await redis.client.lLen("l")).toBe(3)
    await redis.client.lPush("l", "d")
    expect(await redis.client.lLen("l")).toBe(4)
  })

  it("mirrors WRONGTYPE across the string/list boundary in both directions", async () => {
    const redis = createInMemoryRedis({ seed: { str: "plain" } })
    await expect(redis.client.lLen("str")).rejects.toThrow(WrongTypeError)
    await expect(redis.client.lPush("str", "x")).rejects.toThrow(WrongTypeError)
    await redis.client.lPush("list", "x")
    await expect(redis.client.get("list")).rejects.toThrow(WrongTypeError)
  })

  it("a list honours TTL like any other key", async () => {
    let now = 1_000
    const redis = createInMemoryRedis({ now: () => now })
    await redis.client.lPush("l", "a")
    expect(await redis.client.expire("l", 5)).toBe(true)
    expect(await redis.client.lLen("l")).toBe(1)
    now += 6_000
    expect(await redis.client.lLen("l")).toBe(0)
    expect(redis.keys()).toEqual([])
  })

  it("validates arguments on an EMPTY store", async () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    await expect(loose(redis.client).lLen(5)).rejects.toThrow(/key must be a string/)
    await expect(loose(redis.client).lPush("", "v")).rejects.toThrow(/key must not be empty/)
    await expect(loose(redis.client).lPush("k", [])).rejects.toThrow(/at least one value/)
    await expect(loose(redis.client).lPush("k", {})).rejects.toThrow(/value must be a string/)
  })
})
