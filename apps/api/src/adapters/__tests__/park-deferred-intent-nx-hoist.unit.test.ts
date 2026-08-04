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
// These tests stub Redis (just enough to satisfy the framework primitive's
// happy path) so they run without a Docker testcontainer — the goal is to
// exercise the THROW path, not the actual SET semantics.

import { describe, it, expect, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import {
  parkDeferredIntentWithNxGuard,
  ParkVerificationFieldsMissingError,
} from "../park-deferred-intent-nx.js"

function rk(key: string): string {
  return `unit-q2:${key}`
}

// In-memory Redis stub that satisfies the framework's ParkRedis interface
// just enough for the happy-path tests (SET NX, INCR, EXPIRE NX, DECR, DEL).
// We do NOT need to model exact semantics — the wrapper either throws BEFORE
// touching Redis (fail-loud paths) or succeeds against the stub.
//
// F-22: this stub deliberately does NOT carry `evalIncrCheck` or
// `compareAndDelete`, so inside THIS file the framework takes its non-atomic
// quota branch. That is intentional. Faking those two members here would be
// Lua-emulation theater (W4 RULE 3) — an in-process `eval` decides the very
// comparison the script exists to make atomic, and hands back green on a path
// with no real coverage. Production cannot reach that branch: every park call
// site is composed through `createParkRedisCapabilities()`, where both members
// are REQUIRED. The atomicity claims live at the testcontainer layer, in
// `apps/api/src/__tests__/park-nx-release-failure-mode.test.ts`.
function makeRedisStub(): {
  get: (key: string) => Promise<string | null>
  set: (
    key: string,
    value: string,
    options: { EX?: number; NX?: boolean },
  ) => Promise<string | null>
  del: (key: string) => Promise<unknown>
  incr: (key: string) => Promise<number>
  decr: (key: string) => Promise<number>
  expire: (key: string, seconds: number) => Promise<unknown>
} {
  const store = new Map<string, string>()
  const counters = new Map<string, number>()
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async set(key, value, options) {
      if (options.NX && store.has(key)) return null
      store.set(key, value)
      return "OK"
    },
    async del(key) {
      const had = store.delete(key)
      return had ? 1 : 0
    },
    async incr(key) {
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      return n
    },
    async decr(key) {
      const n = (counters.get(key) ?? 0) - 1
      counters.set(key, n)
      return n
    },
    async expire(_key, _seconds) {
      return 1
    },
  }
}

function buildArgs(envelopeOverrides: Record<string, unknown>): {
  envelope: Record<string, unknown>
  signal: string
  ttlSeconds: number
  redis: ReturnType<typeof makeRedisStub>
  rk: (raw: string) => string
} {
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
    redis: makeRedisStub(),
    rk,
  }
}

describe("W8-Q2 — hoistAndValidateVerificationFields", () => {
  // ── Happy path: all four top-level fields present ────────────────────────
  it("parks successfully when all four verification fields are present at top level", async () => {
    const result = await parkDeferredIntentWithNxGuard(
      buildArgs({}) as unknown as Parameters<
        typeof parkDeferredIntentWithNxGuard
      >[0],
    )
    expect(result.parked).toBe(true)
  })

  // ── Hoist behaviour: actor.principal → actorPrincipal ────────────────────
  it("auto-hoists actor.principal → actorPrincipal when the top-level field is omitted", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
      signal: string
      ttlSeconds: number
      redis: ReturnType<typeof makeRedisStub>
      rk: (raw: string) => string
    }
    // Caller forgot to copy principal up, but kept actor.principal nested.
    args.envelope.actor = { sessionId: "sess_q2", principal: "llm" }
    delete args.envelope.actorPrincipal

    const result = await parkDeferredIntentWithNxGuard(
      args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
    )
    expect(result.parked).toBe(true)
  })

  // ── Fail-loud: each of the four required fields, exercised individually ──
  it("throws when `version` is missing at top level", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
    }
    delete args.envelope.version
    await expect(
      parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      ),
    ).rejects.toBeInstanceOf(ParkVerificationFieldsMissingError)
  })

  it("throws when `nonce` is missing at top level", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
    }
    delete args.envelope.nonce
    await expect(
      parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      ),
    ).rejects.toBeInstanceOf(ParkVerificationFieldsMissingError)
  })

  it("throws when `taint` is missing at top level", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
    }
    delete args.envelope.taint
    await expect(
      parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      ),
    ).rejects.toBeInstanceOf(ParkVerificationFieldsMissingError)
  })

  it("throws when both `actorPrincipal` and nested `actor.principal` are missing (nothing to hoist from)", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
    }
    delete args.envelope.actorPrincipal
    // No nested actor.principal either.
    args.envelope.actor = { sessionId: "sess_q2" }
    await expect(
      parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      ),
    ).rejects.toBeInstanceOf(ParkVerificationFieldsMissingError)
  })

  it("throws when `origin` is missing at top level (041 — part of the hash recipe)", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
    }
    delete args.envelope.origin
    await expect(
      parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      ),
    ).rejects.toBeInstanceOf(ParkVerificationFieldsMissingError)
  })

  // ── Error carries the diagnostic payload ─────────────────────────────────
  it("the thrown error lists ALL missing fields and the intentHash for triage", async () => {
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
    }
    delete args.envelope.version
    delete args.envelope.nonce
    let caught: unknown = null
    try {
      await parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      )
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
    const args = buildArgs({}) as unknown as {
      envelope: Record<string, unknown>
      redis: ReturnType<typeof makeRedisStub>
    }
    delete args.envelope.taint
    const redisSetSpy = vi.spyOn(args.redis, "set")
    await expect(
      parkDeferredIntentWithNxGuard(
        args as unknown as Parameters<typeof parkDeferredIntentWithNxGuard>[0],
      ),
    ).rejects.toBeInstanceOf(ParkVerificationFieldsMissingError)
    expect(redisSetSpy).not.toHaveBeenCalled()
  })
})
