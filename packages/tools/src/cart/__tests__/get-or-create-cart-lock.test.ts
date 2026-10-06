// F-21 — the cart-creation lock is ownership-safe (Hard Rule #10).
//
// ── What was wrong ───────────────────────────────────────────────────────────
//
// `getOrCreateCart` took its creation lock with a CONSTANT value
// (`set(lockKey, "1", { NX: true, EX: 10 })`) and released it with an
// unconditional `del(lockKey)` in `finally`. Two consequences, both live:
//
//   1. The `finally` ran on EVERY path — including the branch where the SET
//      returned null. A caller that never held the lock deleted it anyway,
//      out from under the caller that did.
//   2. Even for the winner, a 10s TTL that lapsed during a slow Medusa POST
//      meant the `del` removed whatever lock was there NOW — i.e. the next
//      caller's fresh one.
//
// Either way two callers proceeded to POST /store/carts and both wrote
// `rk("cart:active:session:<conversationId>")`, the key that decides what a
// checkout BUYS.
//
// ── What this file proves, and what it deliberately does not ─────────────────
//
// THIS layer proves the SHAPE of the discipline at the `getOrCreateCart` seam:
// that a fresh UUID token is minted per acquisition, that the release is the
// ownership-checking Lua `eval` and never a `del`, that the token released is
// the token acquired, and that a caller that lost the race releases NOTHING.
//
// It does NOT prove the compare-and-delete SEMANTICS. Those are Redis
// server-side atomicity; per W4 RULE 3 the canonical in-memory adapter refuses
// `eval` outright rather than emulate it, and this file honours that — the
// `eval` seam below RECORDS the call and answers a canned reply, it does not
// interpret the script. The semantic proof lives against a real Redis in
// `apps/api/src/__tests__/cart-create-lock-ownership.test.ts`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryRedis, type InMemoryRedis } from "../../testing/in-memory-redis.js"
import { rk } from "../../redis/key.js"
import { makeCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockCartsCreate = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

vi.mock("../../medusa/store-adjudicated.js", () => ({
  medusaStoreAdjudicated: { carts: { create: mockCartsCreate } },
}))

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({ record: vi.fn() }),
}))

// Both the module under test AND the shared lock helper it delegates to read
// their client from here, so one mock covers the whole path.
vi.mock("../../redis/client.js", () => ({
  getRedisClient: mockGetRedisClient,
}))

const { getOrCreateCart } = await import("../get-or-create-cart.js")

// ── The client seam ──────────────────────────────────────────────────────────

interface EvalCall {
  script: string
  keys: readonly string[]
  args: readonly string[]
}

/**
 * Spy-delegate over the canonical in-memory adapter: every command is a
 * `vi.fn()` that forwards to the real double, so the keyspace semantics stay
 * real AND every call is observable. (The adapter's own client is a Proxy and
 * therefore has no spyable own properties.)
 *
 * `eval` is the one exception, and NOT an emulation: it records the script and
 * arguments and returns 1. Interpreting the Lua here would be exactly the
 * theater W4 RULE 3 forbids.
 */
function makeSeam(mem: InMemoryRedis): {
  client: unknown
  evalCalls: EvalCall[]
  del: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
} {
  const evalCalls: EvalCall[] = []
  const del = vi.fn((key: string) => mem.client.del(key))
  const set = vi.fn((key: string, value: string, opts?: unknown) =>
    (mem.client.set as (k: string, v: string, o?: unknown) => unknown)(key, value, opts),
  )
  const client = {
    get: vi.fn((key: string) => mem.client.get(key)),
    set,
    del,
    expire: vi.fn((key: string, seconds: number) => mem.client.expire(key, seconds)),
    eval: vi.fn(
      async (script: string, opts: { keys: string[]; arguments: string[] }) => {
        evalCalls.push({ script, keys: opts.keys, args: opts.arguments })
        return 1
      },
    ),
  }
  return { client, evalCalls, del, set }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Set BEFORE the rk() calls below: rk reads APP_ENV at call time (FE-D26), so a
// constant computed at module load under a different APP_ENV than the one the
// tests run with would name a keyspace the code never touches.
process.env.APP_ENV = "test"

const CTX = makeCtx({ sessionId: "sess_f21" })
const LOCK_KEY = rk("cart:create:lock:sess_f21")
const CART_KEY = rk("cart:active:session:sess_f21")

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Every `set` issued against the creation-lock key, in order. */
function lockSets(seam: ReturnType<typeof makeSeam>): Array<{ value: string; opts: unknown }> {
  return seam.set.mock.calls
    .filter((c) => c[0] === LOCK_KEY)
    .map((c) => ({ value: c[1] as string, opts: c[2] }))
}

let mem: InMemoryRedis
let seam: ReturnType<typeof makeSeam>
const originalAppEnv = process.env.APP_ENV

beforeEach(() => {
  process.env.APP_ENV = "test"
  vi.clearAllMocks()
  mem = createInMemoryRedis()
  seam = makeSeam(mem)
  mockGetRedisClient.mockResolvedValue(seam.client)
  mockCartsCreate.mockResolvedValue({ cart: { id: "cart_new_01" } })
  mockMedusaStoreFetch.mockResolvedValue({ cart: { id: "cart_new_01", items: [], total: 0 } })
})

afterEach(() => {
  if (originalAppEnv === undefined) delete process.env.APP_ENV
  else process.env.APP_ENV = originalAppEnv
})

// ── Acquisition: a token, not a constant ─────────────────────────────────────

describe("getOrCreateCart — creation-lock acquisition (F-21)", () => {
  it("takes the lock with a UUID token, never the constant \"1\"", async () => {
    await getOrCreateCart({}, CTX)

    const sets = lockSets(seam)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).not.toBe("1")
    expect(sets[0]?.value).toMatch(UUID_V4)
  })

  it("mints a DISTINCT token per acquisition", async () => {
    await getOrCreateCart({}, CTX)
    // Clear the lock the first call released so the second can acquire.
    mem.flush()
    await getOrCreateCart({}, CTX)

    const values = lockSets(seam).map((s) => s.value)
    expect(values).toHaveLength(2)
    expect(new Set(values).size).toBe(2)
  })

  it("keeps the pre-F-21 key and TTL — rk() key, NX, EX 10", async () => {
    await getOrCreateCart({}, CTX)

    expect(seam.set).toHaveBeenCalledWith(LOCK_KEY, expect.any(String), {
      EX: 10,
      NX: true,
    })
  })
})

// ── Release: compare-and-delete, never an unconditional DEL ──────────────────

describe("getOrCreateCart — creation-lock release (F-21)", () => {
  it("releases through the ownership-checking Lua script, not del()", async () => {
    await getOrCreateCart({}, CTX)

    expect(seam.evalCalls).toHaveLength(1)
    expect(seam.evalCalls[0]?.keys).toEqual([LOCK_KEY])
    // The lock key is never handed to DEL. (The cart key legitimately can be —
    // the stale-cart cleanup path — so this is scoped to the lock key.)
    expect(seam.del.mock.calls.map((c) => c[0])).not.toContain(LOCK_KEY)
  })

  it("releases the SAME token it acquired (ownership identity)", async () => {
    await getOrCreateCart({}, CTX)

    const acquired = lockSets(seam)[0]?.value
    expect(acquired).toMatch(UUID_V4)
    expect(seam.evalCalls[0]?.args).toEqual([acquired])
  })

  it("uses a script that deletes only on a value match", async () => {
    await getOrCreateCart({}, CTX)

    const script = seam.evalCalls[0]?.script ?? ""
    // Reads the key, compares to ARGV[1], deletes on match, 0 otherwise.
    expect(script).toMatch(/get.{0,4}KEYS\[1\]/i)
    expect(script).toMatch(/ARGV\[1\]/)
    expect(script).toMatch(/del.{0,4}KEYS\[1\]/i)
    expect(script).toMatch(/else\s+return 0/i)
  })
})

// ── The lost-race branch: release NOTHING ────────────────────────────────────

describe("getOrCreateCart — lock-acquisition failure (F-21)", () => {
  beforeEach(async () => {
    // Another caller already holds the lock, with ITS OWN token.
    await mem.client.set(LOCK_KEY, "other-callers-token", { EX: 10, NX: true })
  })

  it("does not release a lock it never acquired", async () => {
    await getOrCreateCart({}, CTX)

    // This is the sharpest form of the defect: the pre-fix `finally` ran on
    // this branch too and deleted the WINNER's lock.
    expect(seam.evalCalls).toHaveLength(0)
    expect(seam.del.mock.calls.map((c) => c[0])).not.toContain(LOCK_KEY)
    expect(mem.peek(LOCK_KEY)).toBe("other-callers-token")
  })

  it("still returns the raced cart when the winner wrote one (behaviour unchanged)", async () => {
    // The winner finishes while we sit in the 500ms back-off: its cart appears
    // only AFTER our NX SET has already been refused.
    seam.set.mockImplementation(async (key: string, value: string, opts?: unknown) => {
      const reply = await (
        mem.client.set as (k: string, v: string, o?: unknown) => Promise<unknown>
      )(key, value, opts)
      if (key === LOCK_KEY && reply === null) {
        await mem.client.set(CART_KEY, "cart_from_winner")
      }
      return reply
    })

    const result = await getOrCreateCart({}, CTX)

    expect(result.cartId).toBe("cart_from_winner")
    expect(mockCartsCreate).not.toHaveBeenCalled()
  })

  it("still proceeds to create when no cart appeared (behaviour unchanged)", async () => {
    const result = await getOrCreateCart({}, CTX)

    expect(mockCartsCreate).toHaveBeenCalledTimes(1)
    expect(result.cartId).toBe("cart_new_01")
    // …and the other caller's lock is STILL intact afterwards.
    expect(mem.peek(LOCK_KEY)).toBe("other-callers-token")
  })
})
