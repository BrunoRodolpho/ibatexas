// distributed-lock — the shared ownership-safe lock (Hard Rule #10).
//
// F-21 split `acquireLock` into a key-building half and an `acquireLockAtKey`
// half so `cart/get-or-create-cart.ts` could reuse THIS implementation at its
// own pre-existing key instead of inlining a second copy of the Lua. This file
// pins that the split was neutral: `acquireLock` still builds
// `rk("lock:<resource>")` and still mints a UUID per acquisition, and both
// entry points release through the same compare-and-delete script.
//
// The compare-and-delete SEMANTICS are Redis server-side atomicity and are not
// provable here (W4 RULE 3) — see
// `apps/api/src/__tests__/cart-create-lock-ownership.test.ts`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryRedis, type InMemoryRedis } from "../../testing/in-memory-redis.js"
import { rk } from "../key.js"

const mockGetRedisClient = vi.hoisted(() => vi.fn())

vi.mock("../client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

const { acquireLock, acquireLockAtKey, acquireLockAtKeyOn } = await import(
  "../distributed-lock.js"
)

interface EvalCall {
  script: string
  keys: readonly string[]
  args: readonly string[]
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let mem: InMemoryRedis
let evalCalls: EvalCall[]
let del: ReturnType<typeof vi.fn>
const originalAppEnv = process.env.APP_ENV

beforeEach(() => {
  process.env.APP_ENV = "test"
  vi.clearAllMocks()
  mem = createInMemoryRedis()
  evalCalls = []
  del = vi.fn((key: string) => mem.client.del(key))
  mockGetRedisClient.mockResolvedValue({
    get: (key: string) => mem.client.get(key),
    set: (key: string, value: string, opts?: unknown) =>
      (mem.client.set as (k: string, v: string, o?: unknown) => unknown)(key, value, opts),
    del,
    // Recorded, NOT emulated (W4 RULE 3).
    eval: async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      evalCalls.push({ script, keys: opts.keys, args: opts.arguments })
      return 1
    },
  })
})

afterEach(() => {
  if (originalAppEnv === undefined) delete process.env.APP_ENV
  else process.env.APP_ENV = originalAppEnv
})

describe("acquireLock", () => {
  it("builds rk(\"lock:<resource>\") — key convention unchanged by the F-21 split", async () => {
    const handle = await acquireLock("payment:abc123")

    expect(handle?.key).toBe(rk("lock:payment:abc123"))
    expect(mem.peek(rk("lock:payment:abc123"))).toBe(handle?.value)
  })

  it("returns null when the lock is already held", async () => {
    await acquireLock("payment:abc123")

    expect(await acquireLock("payment:abc123")).toBeNull()
  })
})

describe("acquireLockAtKey", () => {
  it("locks the key it is given, unprefixed", async () => {
    const key = rk("cart:create:lock:sess_1")
    const handle = await acquireLockAtKey(key)

    expect(handle?.key).toBe(key)
    expect(mem.peek(key)).toBe(handle?.value)
  })

  it("mints a fresh UUID token per acquisition", async () => {
    const a = await acquireLockAtKey(rk("res:a"))
    const b = await acquireLockAtKey(rk("res:b"))

    expect(a?.value).toMatch(UUID_V4)
    expect(b?.value).toMatch(UUID_V4)
    expect(a?.value).not.toBe(b?.value)
  })

  it("honours the ttlSeconds argument", async () => {
    // A remaining-TTL read is a DECAYING value: against the suite's real-clock
    // adapter, exact equality is a flake by construction (dev CI measured 41999
    // when 1ms elapsed between the SET and the read). The adapter's clock is
    // INJECTABLE, so this case runs on its own frozen clock and keeps the exact
    // pin — the sharpest form of "the TTL was set FROM ttlSeconds".
    const frozen = createInMemoryRedis({ now: () => 1_700_000_000_000 })
    mockGetRedisClient.mockResolvedValue({
      get: (key: string) => frozen.client.get(key),
      set: (key: string, value: string, opts?: unknown) =>
        (frozen.client.set as (k: string, v: string, o?: unknown) => unknown)(key, value, opts),
      del: (key: string) => frozen.client.del(key),
      eval: async () => 1,
    })

    await acquireLockAtKey(rk("res:ttl"), 42)

    expect(frozen.ttlMs(rk("res:ttl"))).toBe(42_000)
  })

  it("returns null when the key is already held", async () => {
    await acquireLockAtKey(rk("res:held"))

    expect(await acquireLockAtKey(rk("res:held"))).toBeNull()
  })

  it("releases via the compare-and-delete script, never an unconditional DEL", async () => {
    const handle = await acquireLockAtKey(rk("res:rel"))
    await handle?.release()

    expect(evalCalls).toHaveLength(1)
    expect(evalCalls[0]?.keys).toEqual([rk("res:rel")])
    expect(evalCalls[0]?.args).toEqual([handle?.value])
    expect(del).not.toHaveBeenCalled()
  })

  it("hands acquireLock the very same release script", async () => {
    const viaResource = await acquireLock("same-script")
    await viaResource?.release()
    const viaKey = await acquireLockAtKey(rk("lock:same-script-2"))
    await viaKey?.release()

    expect(evalCalls).toHaveLength(2)
    expect(evalCalls[0]?.script).toBe(evalCalls[1]?.script)
  })
})

// ── The injected-client form (F-21 class rollout) ────────────────────────────
//
// `acquireLockAtKeyOn(redis, key, ttl)` exists because the R5 rollout THREADS a
// Redis client down each route family (PR #524): `routes/cart.ts` resolves every
// Redis touch through `CartRouteDeps.redis`, so a lock helper that reached for
// the singleton internally would reintroduce exactly the hidden global that
// rollout removed. Same injected-first-parameter shape as `atomicIncr`.
//
// What these cases pin is that the injection is REAL — the commands land on the
// client passed in, and the singleton is never consulted — plus that
// `acquireLockAtKey` still behaves identically now that it delegates here.

describe("acquireLockAtKeyOn — the injected-client form", () => {
  /** A second, independent keyspace + spy set: the "other" client. */
  function otherClient() {
    const other = createInMemoryRedis()
    const calls: EvalCall[] = []
    return {
      mem: other,
      evalCalls: calls,
      client: {
        set: (key: string, value: string, opts?: unknown) =>
          (other.client.set as (k: string, v: string, o?: unknown) => unknown)(
            key,
            value,
            opts,
          ) as Promise<string | null>,
        eval: async (
          script: string,
          opts: { keys: string[]; arguments: string[] },
        ) => {
          calls.push({ script, keys: opts.keys, args: opts.arguments })
          return 1
        },
      },
    }
  }

  it("claims on the INJECTED client, never the singleton", async () => {
    const other = otherClient()

    const handle = await acquireLockAtKeyOn(other.client, rk("res:injected"))

    expect(handle).not.toBeNull()
    // The claim landed on the injected keyspace …
    expect(other.mem.peek(rk("res:injected"))).toBe(handle?.value)
    // … and NOT on the singleton's. Both halves matter: the first alone would
    // pass if the helper wrote to both.
    expect(mem.peek(rk("res:injected"))).toBeUndefined()
    expect(mockGetRedisClient).not.toHaveBeenCalled()
  })

  it("releases on the INJECTED client, through the compare-and-delete script", async () => {
    const other = otherClient()
    const handle = await acquireLockAtKeyOn(other.client, rk("res:injected-rel"))

    await handle?.release()

    expect(other.evalCalls).toHaveLength(1)
    expect(other.evalCalls[0]?.keys).toEqual([rk("res:injected-rel")])
    expect(other.evalCalls[0]?.args).toEqual([handle?.value])
    // The singleton saw neither the eval nor a del.
    expect(evalCalls).toHaveLength(0)
    expect(del).not.toHaveBeenCalled()
    expect(mockGetRedisClient).not.toHaveBeenCalled()
  })

  it("mints a UUID token per acquisition, never a constant", async () => {
    const other = otherClient()

    const a = await acquireLockAtKeyOn(other.client, rk("res:tok-a"))
    const b = await acquireLockAtKeyOn(other.client, rk("res:tok-b"))

    expect(a?.value).toMatch(UUID_V4)
    expect(b?.value).toMatch(UUID_V4)
    expect(a?.value).not.toBe(b?.value)
    expect(a?.value).not.toBe("1")
  })

  it("returns null when the injected client's key is already held", async () => {
    const other = otherClient()
    await acquireLockAtKeyOn(other.client, rk("res:injected-held"))

    expect(
      await acquireLockAtKeyOn(other.client, rk("res:injected-held")),
    ).toBeNull()
  })

  it("honours ttlSeconds on the injected client", async () => {
    const other = otherClient()

    await acquireLockAtKeyOn(other.client, rk("res:injected-ttl"), 120)

    // The adapter models expiry as `now() + ttl`; a BOUNDED read, not an exact
    // one, because the two `now()`s differ by a millisecond or two (#517).
    const ttlMs = other.mem.ttlMs(rk("res:injected-ttl"))
    expect(ttlMs).not.toBeNull()
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(120_000)
  })

  it("uses the SAME release script as both singleton entry points", async () => {
    const other = otherClient()
    const injected = await acquireLockAtKeyOn(other.client, rk("res:same"))
    await injected?.release()
    const viaKey = await acquireLockAtKey(rk("lock:same"))
    await viaKey?.release()

    // One release script in the package — the #514 ruling's "no second inline
    // copy of the Lua" property, now across three entry points.
    expect(other.evalCalls[0]?.script).toBe(evalCalls[0]?.script)
  })

  it("acquireLockAtKey still resolves the singleton PER COMMAND after delegating", async () => {
    // Behaviour preservation. Before F-21's class rollout, `acquireLockAtKey`
    // called `getRedisClient()` at acquire AND again at release. It now
    // delegates to the injected form through a lazily-resolving adapter, and
    // this pins that the resolution timing did not quietly change to
    // capture-once.
    const handle = await acquireLockAtKey(rk("res:per-command"))
    expect(mockGetRedisClient).toHaveBeenCalledTimes(1)

    await handle?.release()
    expect(mockGetRedisClient).toHaveBeenCalledTimes(2)
  })
})
