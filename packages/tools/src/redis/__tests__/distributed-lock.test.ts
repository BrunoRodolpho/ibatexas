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

const { acquireLock, acquireLockAtKey } = await import("../distributed-lock.js")

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
    await acquireLockAtKey(rk("res:ttl"), 42)

    expect(mem.ttlMs(rk("res:ttl"))).toBe(42_000)
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
