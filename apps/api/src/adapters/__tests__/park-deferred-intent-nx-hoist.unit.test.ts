// W8-Q2 — unit tests for the NX-guard park wrapper's
// `hoistAndValidateVerificationFields` invariant.
//
// The framework's `verifyParkedEnvelopeHash` reads five top-level fields off
// the parked envelope to re-derive `intentHash`:
//   - `version`
//   - `nonce`
//   - `taint`
//   - `actorPrincipal`
//   - `origin`           (041 folded provenance into the intentHash recipe)
//
// If ANY of these is missing on the parked blob, the verifier returns
// `{verified: null, reason: "missing_fields"}` and (in warn mode) the
// resume path silently proceeds — tamper-at-rest detection is structurally
// inert. Pre-W7-G3 the wrapper hoisted nothing; W7-G3 hoisted only
// `actorPrincipal`. W8-Q2 extends the contract: the wrapper now refuses
// (throws `ParkVerificationFieldsMissingError`) at park time whenever any
// of the five fields cannot be sourced.
//
// ── Why this file stays a UNIT test, and what its Redis argument is ─────────
//
// Phase 5 ruling (the second of the two F-22-deferred migrations). The
// property under test is `hoistAndValidateVerificationFields`, and that
// function runs to completion BEFORE the wrapper issues a single Redis
// command — `park-nx.ts` calls it on line 1 of the wrapper, and the SETNX
// placeholder is the next statement. So the property is Redis-INDEPENDENT and
// belongs at the unit layer; putting it behind a testcontainer would buy no
// signal and would spend a container on seven cases that provably never reach
// the socket (the ruling's Q2: coverage is organized by script shape, "8
// container suites, not 20").
//
// What DID have to change is the double. Before Phase 5 this file handed the
// wrapper a plain-object stub that deliberately omitted `evalIncrCheck` and
// `compareAndDelete`, so the two happy-path cases ran the framework's
// NON-ATOMIC quota fallback inside a unit test — the dead branch F-22's
// composition guarantee exists to close. That is gone. The `redis` argument is
// now typed as the real `ParkRedisCapabilities` and every member is a
// TRIPWIRE: it throws `RedisTouchedSentinel`. Nothing here emulates a Redis
// command, least of all a Lua one (W4 RULE 3), and no code path in this file
// reaches `parkDeferredIntent` at all.
//
// The tripwire is what makes the negative cases non-vacuous in BOTH
// directions:
//
//   • treatment (cases 3–8) — a missing field must throw
//     `ParkVerificationFieldsMissingError`, and case 9 pins that no Redis
//     command was issued on the way there.
//   • control (cases 1–2) — a COMPLETE envelope must get PAST validation and
//     touch Redis, surfacing as `RedisTouchedSentinel`. Without this pair a
//     validator rewritten to throw unconditionally would keep all seven
//     negative cases green (F-14).
//
// The control's reach is exactly what the retired happy-path cases asserted
// (`result.parked === true` proved "the wrapper did not refuse", nothing
// more). The STRONGER statement — that the hoist actually populates
// `actorPrincipal` on the blob Redis stores, and that the stored blob
// hash-verifies — is proven on real Redis by
// `park-deferred-intent-nx-hash.test.ts` ("hoist auto-corrects: caller passes
// envelope WITHOUT explicit top-level actorPrincipal"), which reads the raw
// bytes back and runs `verifyParkedEnvelopeHash` over them.

import { describe, it, expect, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { deferParkKey } from "@adjudicate/runtime"
import {
  parkDeferredIntentWithNxGuard,
  ParkVerificationFieldsMissingError,
} from "../park-deferred-intent-nx.js"
import type { ParkRedisCapabilities } from "../park-redis-capabilities.js"

function rk(key: string): string {
  return `unit-q2:${key}`
}

/**
 * Raised by every member of the tripwire below. Reaching Redis is not a
 * failure of this file's subject — it is this file's CONTROL: it proves the
 * wrapper got past `hoistAndValidateVerificationFields` rather than refusing.
 */
class RedisTouchedSentinel extends Error {
  constructor(command: string) {
    super(`[unit-q2 tripwire] the wrapper issued redis.${command}()`)
    this.name = "RedisTouchedSentinel"
  }
}

/**
 * A `ParkRedisCapabilities` whose every command REFUSES.
 *
 * Typed as the production contract (F-22) rather than cast into it, so the
 * atomic members are declared — but declared as refusals, never as JS
 * re-implementations. `evalIncrCheck` and `compareAndDelete` are Lua; an
 * in-process version of either decides in our own process the very comparison
 * the script exists to make atomic, which is the theater W4 RULE 3 forbids and
 * `createInMemoryRedis` refuses outright. Their semantics are proven on real
 * Redis in `src/__tests__/park-nx-release-failure-mode.test.ts` (F-22), and
 * nothing in this file needs them: validation either refuses before the first
 * command, or the first command trips this wire.
 */
function makeRedisTripwire(): ParkRedisCapabilities {
  return {
    set: () => Promise.reject(new RedisTouchedSentinel("set")),
    incr: () => Promise.reject(new RedisTouchedSentinel("incr")),
    decr: () => Promise.reject(new RedisTouchedSentinel("decr")),
    expire: () => Promise.reject(new RedisTouchedSentinel("expire")),
    evalIncrCheck: () =>
      Promise.reject(new RedisTouchedSentinel("evalIncrCheck")),
    compareAndDelete: () =>
      Promise.reject(new RedisTouchedSentinel("compareAndDelete")),
  }
}

interface TestArgs {
  envelope: Record<string, unknown>
  signal: string
  ttlSeconds: number
  redis: ParkRedisCapabilities
  rk: (raw: string) => string
}

function buildArgs(envelopeOverrides: Record<string, unknown>): TestArgs {
  const base = buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_q2" },
    actor: { sessionId: "sess_q2", principal: "llm" },
    taint: "UNTRUSTED",
    nonce: "Q2-NONCE",
  })
  return {
    envelope: {
      intentHash: base.intentHash,
      kind: base.kind,
      actor: { sessionId: base.actor.sessionId },
      payload: base.payload,
      version: base.version,
      nonce: base.nonce,
      taint: base.taint,
      actorPrincipal: base.actor.principal,
      origin: base.origin,
      ...envelopeOverrides,
    },
    signal: "payment.confirmed",
    ttlSeconds: 60,
    redis: makeRedisTripwire(),
    rk,
  }
}

/** The single cast in this file: the envelope is deliberately malformed. */
function park(args: TestArgs): Promise<unknown> {
  return parkDeferredIntentWithNxGuard(
    args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
  )
}

describe("W8-Q2 — hoistAndValidateVerificationFields", () => {
  // ── CONTROL: a complete envelope gets PAST validation ────────────────────
  // The pair-mate of every negative case below. If this stops reaching Redis,
  // the negatives are passing because the validator refuses everything.
  it("a complete envelope passes validation and reaches Redis (SETNX placeholder)", async () => {
    const args = buildArgs({})
    const setSpy = vi.spyOn(args.redis, "set")

    await expect(park(args)).rejects.toBeInstanceOf(RedisTouchedSentinel)

    // Validation passed, and the FIRST thing the wrapper did was claim the
    // park slot for this session.
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0]![0]).toBe(rk(deferParkKey("sess_q2")))
  })

  // ── CONTROL: hoist behaviour — actor.principal → actorPrincipal ──────────
  it("auto-hoists actor.principal → actorPrincipal when the top-level field is omitted", async () => {
    const args = buildArgs({})
    // Caller forgot to copy principal up, but kept actor.principal nested.
    args.envelope.actor = { sessionId: "sess_q2", principal: "llm" }
    delete args.envelope.actorPrincipal
    const setSpy = vi.spyOn(args.redis, "set")

    // The hoist sourced actorPrincipal from the nested actor, so validation
    // passed and the wrapper proceeded. Without the hoist this would be the
    // `ParkVerificationFieldsMissingError` of the "nothing to hoist from"
    // case below. (That the hoisted value LANDS on the stored blob is proven
    // against real Redis in park-deferred-intent-nx-hash.test.ts.)
    await expect(park(args)).rejects.toBeInstanceOf(RedisTouchedSentinel)
    expect(setSpy).toHaveBeenCalledTimes(1)
  })

  // ── Fail-loud: each of the four required fields, exercised individually ──
  it("throws when `version` is missing at top level", async () => {
    const args = buildArgs({})
    delete args.envelope.version
    await expect(park(args)).rejects.toBeInstanceOf(
      ParkVerificationFieldsMissingError,
    )
  })

  it("throws when `nonce` is missing at top level", async () => {
    const args = buildArgs({})
    delete args.envelope.nonce
    await expect(park(args)).rejects.toBeInstanceOf(
      ParkVerificationFieldsMissingError,
    )
  })

  it("throws when `taint` is missing at top level", async () => {
    const args = buildArgs({})
    delete args.envelope.taint
    await expect(park(args)).rejects.toBeInstanceOf(
      ParkVerificationFieldsMissingError,
    )
  })

  it("throws when both `actorPrincipal` and nested `actor.principal` are missing (nothing to hoist from)", async () => {
    const args = buildArgs({})
    delete args.envelope.actorPrincipal
    // No nested actor.principal either.
    args.envelope.actor = { sessionId: "sess_q2" }
    await expect(park(args)).rejects.toBeInstanceOf(
      ParkVerificationFieldsMissingError,
    )
  })

  it("throws when `origin` is missing at top level (041 — part of the hash recipe)", async () => {
    const args = buildArgs({})
    delete args.envelope.origin
    await expect(park(args)).rejects.toBeInstanceOf(
      ParkVerificationFieldsMissingError,
    )
  })

  // ── Error carries the diagnostic payload ─────────────────────────────────
  it("the thrown error lists ALL missing fields and the intentHash for triage", async () => {
    const args = buildArgs({})
    delete args.envelope.version
    delete args.envelope.nonce
    let caught: unknown = null
    try {
      await park(args)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ParkVerificationFieldsMissingError)
    const e = caught as ParkVerificationFieldsMissingError
    expect(e.missing).toContain("version")
    expect(e.missing).toContain("nonce")
    expect(typeof e.intentHash).toBe("string")
    expect(e.intentHash.length).toBeGreaterThan(0)
    // Both fields surfaced in the message — operators reading logs see what to fix.
    expect(e.message).toMatch(/version/)
    expect(e.message).toMatch(/nonce/)
  })

  // ── Fail-loud refuses BEFORE any Redis write ─────────────────────────────
  it("does not touch Redis when validation throws — no placeholder, no SET", async () => {
    const args = buildArgs({})
    delete args.envelope.taint
    const redisSetSpy = vi.spyOn(args.redis, "set")
    await expect(park(args)).rejects.toBeInstanceOf(
      ParkVerificationFieldsMissingError,
    )
    expect(redisSetSpy).not.toHaveBeenCalled()
    // Belt and braces: the tripwire would have surfaced as
    // RedisTouchedSentinel (not ParkVerificationFieldsMissingError) had ANY
    // command been issued, including one this spy does not watch.
  })
})
