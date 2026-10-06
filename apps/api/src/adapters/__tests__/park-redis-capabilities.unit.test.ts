// F-22 — the composition-root capability contract, unit layer.
//
// What this file proves, and what it deliberately does NOT:
//
//   • PROVES: composition FAILS CLOSED (a loud throw naming the missing
//     command) when the underlying client cannot serve the DEFER park path,
//     and that the composed surface's atomic members exist and delegate to
//     `client.eval` with the exact script + arguments.
//   • DOES NOT prove ATOMICITY. Atomicity is a property of the Redis server,
//     not of this process (W4 RULE 3) — a JS double of `eval` decides the
//     comparison in our own memory and hands back green on a path with no
//     real coverage. The atomicity half lives at the testcontainer layer in
//     `apps/api/src/__tests__/park-nx-release-failure-mode.test.ts`.
//
// The missing-command cases are a HAND-WRITTEN ROLL CALL — one named `it` per
// command — not an `it.each` over `REQUIRED_PARK_REDIS_COMMANDS`. Deriving the
// iteration source from the same list the code under test uses would mean
// deleting a row deletes its own coverage (F-14).

import { describe, expect, it, vi } from "vitest"
import {
  COMPARE_AND_DELETE_SCRIPT,
  EVAL_INCR_CHECK_SCRIPT,
  REQUIRED_PARK_REDIS_COMMANDS,
  RedisCapabilityUnavailableError,
  createParkRedisCapabilities,
} from "../park-redis-capabilities.js"

/**
 * A client that carries EVERY required command. Each member is a `vi.fn()`
 * (spy-delegate) so a call's script + arguments are observable without
 * pretending to implement Redis semantics.
 */
function makeCompleteClient(): {
  eval: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  incr: ReturnType<typeof vi.fn>
  decr: ReturnType<typeof vi.fn>
  expire: ReturnType<typeof vi.fn>
} {
  return {
    eval: vi.fn(async () => 1),
    set: vi.fn(async () => "OK"),
    incr: vi.fn(async () => 1),
    decr: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
  }
}

/** The complete client minus exactly ONE command. */
function makeClientWithout(command: string): Record<string, unknown> {
  const client = makeCompleteClient() as unknown as Record<string, unknown>
  delete client[command]
  return client
}

describe("F-22 — createParkRedisCapabilities fails closed", () => {
  // ── The roll call: one named case per required command ────────────────────
  //
  // Each case is the deletion experiment for exactly one `if` in the factory:
  // remove that line from `createParkRedisCapabilities` and this case — and
  // only this case — reds.

  it("throws when the client cannot `eval` (no Lua ⇒ no compare-and-delete, no atomic quota)", () => {
    expect(() =>
      createParkRedisCapabilities(makeClientWithout("eval")),
    ).toThrow(RedisCapabilityUnavailableError)
    try {
      createParkRedisCapabilities(makeClientWithout("eval"))
    } catch (err) {
      expect((err as RedisCapabilityUnavailableError).missing).toEqual(["eval"])
      expect((err as Error).message).toMatch(/\beval\b/)
    }
  })

  it("throws when the client cannot `set`", () => {
    try {
      createParkRedisCapabilities(makeClientWithout("set"))
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCapabilityUnavailableError)
      expect((err as RedisCapabilityUnavailableError).missing).toEqual(["set"])
    }
  })

  it("throws when the client cannot `incr`", () => {
    try {
      createParkRedisCapabilities(makeClientWithout("incr"))
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCapabilityUnavailableError)
      expect((err as RedisCapabilityUnavailableError).missing).toEqual(["incr"])
    }
  })

  it("throws when the client cannot `decr`", () => {
    try {
      createParkRedisCapabilities(makeClientWithout("decr"))
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCapabilityUnavailableError)
      expect((err as RedisCapabilityUnavailableError).missing).toEqual(["decr"])
    }
  })

  it("throws when the client cannot `expire`", () => {
    try {
      createParkRedisCapabilities(makeClientWithout("expire"))
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCapabilityUnavailableError)
      expect((err as RedisCapabilityUnavailableError).missing).toEqual([
        "expire",
      ])
    }
  })

  // ── Message pin: an operator reading the log learns what to fix ───────────

  it("the throw's message names the policy, not just the symptom", () => {
    let caught: unknown = null
    try {
      createParkRedisCapabilities({})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RedisCapabilityUnavailableError)
    const e = caught as RedisCapabilityUnavailableError
    // Every required command surfaced at once — not one round trip per fix.
    expect(e.missing).toEqual(["eval", "set", "incr", "decr", "expire"])
    expect(e.message).toMatch(/refusing to compose/)
    expect(e.message).toMatch(/NOT an optional feature/)
    expect(e.message).toMatch(/never/)
    expect(e.message).toMatch(/feature-detect/)
  })

  it("a null / undefined client is refused, not dereferenced", () => {
    expect(() => createParkRedisCapabilities(null)).toThrow(
      RedisCapabilityUnavailableError,
    )
    expect(() => createParkRedisCapabilities(undefined)).toThrow(
      RedisCapabilityUnavailableError,
    )
  })

  it("a client carrying every required command composes without throwing", () => {
    expect(() =>
      createParkRedisCapabilities(makeCompleteClient()),
    ).not.toThrow()
  })

  // ── The roll call is complete (name pin, not a count) ─────────────────────

  it("REQUIRED_PARK_REDIS_COMMANDS lists exactly the commands the roll call enforces", () => {
    // Hand-written wire list. If a command is added to the constant without a
    // matching `if` in the factory AND a matching `it` above, this pin is the
    // place the omission surfaces.
    expect([...REQUIRED_PARK_REDIS_COMMANDS]).toEqual([
      "eval",
      "set",
      "incr",
      "decr",
      "expire",
    ])
    // `del` must NOT be here: after F-22 nothing on this path issues an
    // unconditional DEL, so requiring it would re-legitimise the deleted
    // fallback.
    expect([...REQUIRED_PARK_REDIS_COMMANDS]).not.toContain("del")
  })
})

describe("F-22 — the composed surface makes the framework's probe deterministic", () => {
  it("`evalIncrCheck` is present as a function — @adjudicate/runtime's `typeof … === \"function\"` is TRUE here", () => {
    const composed = createParkRedisCapabilities(makeCompleteClient())
    // This is the exact predicate `parkDeferredIntent` evaluates before
    // choosing between the atomic Lua seam and its non-atomic
    // INCR→EXPIRE→check→DECR fallback. In this repo it can only be true.
    expect(typeof composed.evalIncrCheck).toBe("function")
  })

  it("`compareAndDelete` is present as a function — park-nx never has to ask", () => {
    const composed = createParkRedisCapabilities(makeCompleteClient())
    expect(typeof composed.compareAndDelete).toBe("function")
  })
})

describe("F-22 — the composed atomic members delegate to client.eval", () => {
  it("`evalIncrCheck` runs the INCR-check script with [counterKey] and [ttl, max] as strings", async () => {
    const client = makeCompleteClient()
    client.eval.mockResolvedValueOnce(7)
    const composed = createParkRedisCapabilities(client)

    const result = await composed.evalIncrCheck("ibx:defer:count:s1", 1209600, 16)

    expect(result).toBe(7)
    expect(client.eval).toHaveBeenCalledTimes(1)
    expect(client.eval).toHaveBeenCalledWith(EVAL_INCR_CHECK_SCRIPT, {
      keys: ["ibx:defer:count:s1"],
      arguments: ["1209600", "16"],
    })
    // The non-atomic sequence must NOT be issued alongside it.
    expect(client.incr).not.toHaveBeenCalled()
    expect(client.expire).not.toHaveBeenCalled()
    expect(client.decr).not.toHaveBeenCalled()
  })

  it("`evalIncrCheck` returns 0 verbatim when the script reports the cap exceeded", async () => {
    const client = makeCompleteClient()
    client.eval.mockResolvedValueOnce(0)
    const composed = createParkRedisCapabilities(client)
    // The framework reads 0 as "quota exceeded, increment already rolled
    // back". Coercing it to anything else would silently admit an over-cap park.
    expect(await composed.evalIncrCheck("k", 60, 1)).toBe(0)
  })

  it("`compareAndDelete` runs the CAD script with [key] and [expectedValue]", async () => {
    const client = makeCompleteClient()
    client.eval.mockResolvedValueOnce(1)
    const composed = createParkRedisCapabilities(client)

    const deleted = await composed.compareAndDelete("ibx:defer:pending:s1", "tok-abc")

    expect(deleted).toBe(1)
    expect(client.eval).toHaveBeenCalledWith(COMPARE_AND_DELETE_SCRIPT, {
      keys: ["ibx:defer:pending:s1"],
      arguments: ["tok-abc"],
    })
  })

  it("`compareAndDelete` NEVER issues a plain DEL — the client has no `del` to fall back to", async () => {
    // The deleted F-22 fallback was `await r.del?.(parkKey)`. The composed
    // surface does not expose `del` at all, so there is no member for a future
    // edit to reach for.
    const composed = createParkRedisCapabilities(makeCompleteClient())
    expect(
      (composed as unknown as Record<string, unknown>)["del"],
    ).toBeUndefined()
  })

  it("the CAD script is ownership-checked (GET-compare before DEL), not an unconditional DEL", () => {
    // Byte-level pin on the script itself: a future edit that "simplifies" it
    // to `return redis.call('DEL', KEYS[1])` reds here as well as at the
    // testcontainer layer.
    expect(COMPARE_AND_DELETE_SCRIPT).toMatch(/redis\.call\('GET', KEYS\[1\]\)/)
    expect(COMPARE_AND_DELETE_SCRIPT).toMatch(/== ARGV\[1\]/)
    expect(COMPARE_AND_DELETE_SCRIPT).toMatch(/return 0/)
  })

  it("the pass-through members forward to the client unchanged", async () => {
    const client = makeCompleteClient()
    const composed = createParkRedisCapabilities(client)

    await composed.incr("k1")
    await composed.decr("k2")
    await composed.expire("k3", 30)
    await composed.set("k4", "v", { EX: 60 })

    expect(client.incr).toHaveBeenCalledWith("k1")
    expect(client.decr).toHaveBeenCalledWith("k2")
    expect(client.expire).toHaveBeenCalledWith("k3", 30, undefined)
    expect(client.set).toHaveBeenCalledWith("k4", "v", { EX: 60 })
  })

  it("`set` forwards the NX flag the park guard depends on", async () => {
    // park-nx claims the slot with `{EX, NX: true}` (cast past the framework's
    // narrower `{EX}` declaration). If the composed `set` dropped unknown
    // option keys, the SETNX would degrade to a plain SET and the whole
    // collision guard would silently stop working.
    const client = makeCompleteClient()
    const composed = createParkRedisCapabilities(client)

    await composed.set("k", "v", { EX: 60, NX: true } as unknown as {
      EX: number
    })

    expect(client.set).toHaveBeenCalledWith("k", "v", { EX: 60, NX: true })
  })
})
