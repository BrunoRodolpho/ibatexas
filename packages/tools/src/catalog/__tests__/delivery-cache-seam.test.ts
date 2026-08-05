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

// ── R5-S9 — the FIFO half of the list type ───────────────────────────────────
//
// Consumer: `packages/audit-sink/src/redis-spill-storage.ts` — RPUSH on append,
// LPOP until null on drain. The end a value lands on and the end it leaves from
// ARE the contract there, so both are pinned against the LIFO reading.

describe("in-memory-redis — lists (rPush / lPop)", () => {
  it("rPush appends to the TAIL where lPush prepends to the head", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("q", "first")
    await redis.client.rPush("q", "second")
    // Head-first storage: LPOP takes what rPush pushed FIRST. If rPush aliased
    // lPush this would answer "second" — the LIFO reading, green under any
    // assertion that only counts the list.
    expect(await redis.client.lPop("q")).toBe("first")
    await redis.client.lPush("q", "head")
    expect(await redis.client.lPop("q")).toBe("head")
  })

  it("a multi-value rPush keeps argument order (real RPUSH), unlike lPush", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.rPush("q", ["a", "b", "c"])).toBe(3)
    expect(await redis.client.lPop("q")).toBe("a")
    expect(await redis.client.lPop("q")).toBe("b")
    expect(await redis.client.lPop("q")).toBe("c")
  })

  it("drains an RPUSH'd queue in FIFO order, then terminates on null", async () => {
    // The spill storage's whole read contract: `readAll()` LPOPs in a `for(;;)`
    // and returns on null. A double that never answers null spins that loop.
    const redis = createInMemoryRedis()
    for (const v of ["r1", "r2", "r3"]) await redis.client.rPush("audit:spill:queue", v)
    const drained: Array<string | null> = []
    for (;;) {
      const next = await redis.client.lPop("audit:spill:queue")
      if (next === null) break
      drained.push(next)
    }
    expect(drained).toEqual(["r1", "r2", "r3"])
    expect(await redis.client.lPop("audit:spill:queue")).toBeNull()
  })

  it("lPop answers null for a list that never existed", async () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    expect(await redis.client.lPop("never:written")).toBeNull()
  })

  it("emptying a list DELETES the key, as real Redis does", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("q", "only")
    await redis.client.expire("q", 60)
    expect(redis.keys()).toEqual(["q"])
    expect(await redis.client.lPop("q")).toBe("only")
    // Not merely empty — gone. An empty list left behind reports exists=1 and
    // keeps a TTL alive on a key production has already removed.
    expect(redis.keys()).toEqual([])
    expect(await redis.client.exists("q")).toBe(0)
    expect(redis.ttlMs("q")).toBeUndefined()
    expect(await redis.client.lLen("q")).toBe(0)
  })

  it("mirrors WRONGTYPE across the string/list boundary in both directions", async () => {
    const redis = createInMemoryRedis({ seed: { str: "plain" } })
    await expect(redis.client.rPush("str", "x")).rejects.toThrow(WrongTypeError)
    await expect(redis.client.lPop("str")).rejects.toThrow(WrongTypeError)
    await redis.client.rPush("list", "x")
    await expect(redis.client.get("list")).rejects.toThrow(WrongTypeError)
  })

  it("an expired queue pops null rather than its stale head", async () => {
    let now = 1_000
    const redis = createInMemoryRedis({ now: () => now })
    await redis.client.rPush("q", "stale")
    expect(await redis.client.expire("q", 5)).toBe(true)
    now += 6_000
    expect(await redis.client.lPop("q")).toBeNull()
    expect(redis.keys()).toEqual([])
  })

  it("refuses the unmodelled LPOP COUNT form instead of popping one", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("q", ["a", "b"])
    await expect(loose(redis.client).lPop("q", 2)).rejects.toThrow(UnroutedRedisCall)
    await expect(loose(redis.client).lPop("q", 2)).rejects.toThrow(/COUNT form is not modelled/)
    // And it refused BEFORE touching the keyspace — nothing was popped.
    expect(await redis.client.lLen("q")).toBe(2)
  })

  it("validates arguments on an EMPTY store", async () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    await expect(loose(redis.client).lPop(5)).rejects.toThrow(/key must be a string/)
    await expect(loose(redis.client).lPop("")).rejects.toThrow(/key must not be empty/)
    await expect(loose(redis.client).rPush("", "v")).rejects.toThrow(/key must not be empty/)
    await expect(loose(redis.client).rPush("k", [])).rejects.toThrow(/at least one value/)
    await expect(loose(redis.client).rPush("k", {})).rejects.toThrow(/value must be a string/)
  })
})

// ── (5) DECR — the counter's release half (R5-S12) ───────────────────────────
//
// Added for `@adjudicate/runtime`'s `resumeDeferredIntent`, which DECRs the
// per-session parked-envelope quota counter on a successful resume. The
// property worth pinning is the one a hand-rolled double gets wrong: real DECR
// goes NEGATIVE. A double that floors at zero turns a double-release — the
// accounting bug the counter exists to expose — into a silent no-op.

describe("in-memory-redis — decr", () => {
  it("decrements an existing counter and mirrors INCR's round trip", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.incr("test:parks")).toBe(1)
    expect(await redis.client.incr("test:parks")).toBe(2)
    expect(await redis.client.decr("test:parks")).toBe(1)
    expect(redis.peek("test:parks")).toBe("1")
  })

  it("goes NEGATIVE rather than flooring at zero, so an over-release is visible", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.decr("test:parks")).toBe(-1)
    expect(await redis.client.decr("test:parks")).toBe(-2)
    expect(redis.peek("test:parks")).toBe("-2")
  })

  it("mirrors real Redis on DECR against a non-numeric value", async () => {
    const redis = createInMemoryRedis({ seed: { "test:word": "banana" } })
    await expect(redis.client.decr("test:word")).rejects.toThrow(NotAnIntegerError)
  })

  it("validates its key on an EMPTY store", async () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    await expect(loose(redis.client).decr(5)).rejects.toThrow(/key must be a string/)
    await expect(loose(redis.client).decr("")).rejects.toThrow(/key must not be empty/)
  })

  it("refuses a WRONGTYPE key instead of inventing a number", async () => {
    const redis = createInMemoryRedis()
    await redis.client.lPush("test:list", "v")
    await expect(redis.client.decr("test:list")).rejects.toThrow(WrongTypeError)
  })
})

// ── (6) HSCAN — the cursor-wise hash walk (R5 jobs/subscribers rollout) ───────
//
// Consumer: `apps/api/src/jobs/abandoned-cart-checker.ts`, which walks
// `rk("active:carts")` with `do { … } while (cursor !== 0)` and `hDel`s entries
// as it goes. Two properties decide whether that loop is testable at all — the
// cursor must TERMINATE, and a field removed mid-walk must not come back — and
// a hand-rolled `hScan` that answers a constant `{cursor: 0}` has neither.

describe("in-memory-redis — hScan", () => {
  it("returns cursor 0 and no tuples for an absent hash", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.hScan("nope", 0)).toEqual({ cursor: 0, tuples: [] })
  })

  it("pages with a non-zero cursor and TERMINATES on 0, visiting every field once", async () => {
    const redis = createInMemoryRedis()
    await redis.client.hSet("h", "a", "1")
    await redis.client.hSet("h", "b", "2")
    await redis.client.hSet("h", "c", "3")

    const seen: string[] = []
    let cursor = 0
    let pages = 0
    do {
      const res = await redis.client.hScan("h", cursor, { COUNT: 2 })
      cursor = res.cursor
      for (const t of res.tuples) seen.push(`${t.field}=${t.value}`)
      pages++
      if (pages > 10) throw new Error("hScan did not terminate")
    } while (cursor !== 0)

    // Two pages at COUNT 2 over 3 fields — so the non-zero cursor really was
    // handed out, and the loop really did end.
    expect(pages).toBe(2)
    expect(seen.sort()).toEqual(["a=1", "b=2", "c=3"])
  })

  it("never hands back a field hDel'd mid-walk (the delete-while-iterating guarantee)", async () => {
    const redis = createInMemoryRedis()
    for (const f of ["a", "b", "c", "d"]) await redis.client.hSet("h", f, f)

    const seen: string[] = []
    let cursor = 0
    do {
      const res = await redis.client.hScan("h", cursor, { COUNT: 2 })
      cursor = res.cursor
      for (const t of res.tuples) seen.push(t.field)
      // Remove a field the walk has not reached — the exact caller pattern in
      // abandoned-cart-checker (it hDels stale carts as it scans).
      if (seen.length === 2) await redis.client.hDel("h", "d")
    } while (cursor !== 0)

    expect(seen).not.toContain("d")
  })

  it("MATCH filters the FIELD, not the value", async () => {
    const redis = createInMemoryRedis()
    await redis.client.hSet("h", "cart_01", "keep")
    await redis.client.hSet("h", "cart_02", "keep")
    await redis.client.hSet("h", "other_01", "cart_99")

    const res = await redis.client.hScan("h", 0, { MATCH: "cart_*", COUNT: 100 })
    expect(res.cursor).toBe(0)
    expect(res.tuples.map((t) => t.field).sort()).toEqual(["cart_01", "cart_02"])
  })

  it("refuses a cursor that did not come from this client, and one from another key", async () => {
    const redis = createInMemoryRedis()
    await redis.client.hSet("h", "a", "1")
    await redis.client.hSet("h", "b", "2")
    await redis.client.hSet("other", "z", "9")

    await expect(redis.client.hScan("h", 999)).rejects.toThrow(/unknown cursor 999/)

    const page = await redis.client.hScan("h", 0, { COUNT: 1 })
    expect(page.cursor).not.toBe(0)
    await expect(redis.client.hScan("other", page.cursor)).rejects.toThrow(/belongs to key/)
  })

  it("validates arguments on an EMPTY store, and refuses TYPE (meaningless for a hash)", async () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    await expect(loose(redis.client).hScan(5, 0)).rejects.toThrow(/key must be a string/)
    await expect(loose(redis.client).hScan("h", "0")).rejects.toThrow(
      /cursor must be a non-negative integer/,
    )
    await expect(loose(redis.client).hScan("h", -1)).rejects.toThrow(
      /cursor must be a non-negative integer/,
    )
    await expect(loose(redis.client).hScan("h", 0, { MATCH: 5 })).rejects.toThrow(
      /MATCH must be a string/,
    )
    await expect(loose(redis.client).hScan("h", 0, { COUNT: 0 })).rejects.toThrow(
      /COUNT must be a positive integer/,
    )
    await expect(loose(redis.client).hScan("h", 0, { TYPE: "hash" })).rejects.toThrow(
      /unsupported option "TYPE"/,
    )
  })

  it("refuses a WRONGTYPE key instead of answering an empty hash", async () => {
    const redis = createInMemoryRedis({ seed: { str: "plain" } })
    await expect(redis.client.hScan("str", 0)).rejects.toThrow(WrongTypeError)
  })
})

// ── (7) LRANGE — the whole-history read (R5 jobs/subscribers rollout) ─────────
//
// Consumer: `apps/api/src/session/store.ts`'s `loadSession`, reached from
// `jobs/abandoned-cart-checker.ts` through the client it is HANDED — the
// downstream half of the fail-closed Pick rule. Its call is `lRange(key, 0, -1)`
// and the range is INCLUSIVE, which is precisely what a JS `slice(start, stop)`
// mistranslation gets wrong: `slice(0, -1)` drops the last message from every
// history, and no assertion on "we loaded a history" can see it.

describe("in-memory-redis — lRange", () => {
  it("is an empty array for an absent list", async () => {
    const redis = createInMemoryRedis()
    expect(await redis.client.lRange("nope", 0, -1)).toEqual([])
  })

  it("(0, -1) returns the WHOLE list — the inclusive end, not slice()'s", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("l", ["a", "b", "c"])
    // A `slice(0, -1)` implementation answers ["a","b"] here and stays green in
    // any test that only checks "the history is non-empty".
    expect(await redis.client.lRange("l", 0, -1)).toEqual(["a", "b", "c"])
  })

  it("both endpoints are inclusive, and negatives count back from the tail", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("l", ["a", "b", "c", "d"])
    expect(await redis.client.lRange("l", 1, 2)).toEqual(["b", "c"])
    expect(await redis.client.lRange("l", -2, -1)).toEqual(["c", "d"])
    expect(await redis.client.lRange("l", 0, 0)).toEqual(["a"])
  })

  it("clamps out-of-range endpoints and answers [] for an inverted range", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("l", ["a", "b"])
    expect(await redis.client.lRange("l", 0, 99)).toEqual(["a", "b"])
    expect(await redis.client.lRange("l", -99, -1)).toEqual(["a", "b"])
    expect(await redis.client.lRange("l", 2, 1)).toEqual([])
    expect(await redis.client.lRange("l", 5, 9)).toEqual([])
  })

  it("reads the order lPush and rPush actually produce", async () => {
    const redis = createInMemoryRedis()
    await redis.client.rPush("l", "tail")
    await redis.client.lPush("l", "head")
    expect(await redis.client.lRange("l", 0, -1)).toEqual(["head", "tail"])
  })

  it("validates arguments on an EMPTY store", async () => {
    const redis = createInMemoryRedis()
    expect(redis.keys()).toEqual([])
    await expect(loose(redis.client).lRange(5, 0, -1)).rejects.toThrow(/key must be a string/)
    await expect(loose(redis.client).lRange("l", "0", -1)).rejects.toThrow(
      /start must be an integer/,
    )
    await expect(loose(redis.client).lRange("l", 0, 1.5)).rejects.toThrow(/stop must be an integer/)
  })

  it("refuses a WRONGTYPE key instead of answering an empty history", async () => {
    const redis = createInMemoryRedis({ seed: { str: "plain" } })
    await expect(redis.client.lRange("str", 0, -1)).rejects.toThrow(WrongTypeError)
  })
})
