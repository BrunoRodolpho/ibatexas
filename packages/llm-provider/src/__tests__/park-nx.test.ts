// Unit tests for parkDeferredIntentWithNxGuard — audit-2026-05-24 P1-8.
//
// Focus: when the framework's parkDeferredIntent throws mid-park (Redis
// network blip between the INCR and the SET), the wrapper MUST DECR the
// per-session quota counter so the slot is not leaked. Pre-fix, the catch
// block deleted the NX placeholder but left the counter at +1 — the
// session would appear full until the 14d TTL cleared the counter.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { deferCounterKey, deferParkKey } from "@adjudicate/runtime"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

// We don't mock parkDeferredIntent — we drive its behaviour entirely through
// the redis mock (set/incr/expire). That way the wrapper's INCR-then-SET
// sequence really runs and we can prove the DECR happens on the SET-throw.

// ── In-memory Redis stub with deterministic-throw injection ───────────────

interface StubEntry {
  value: string
  ttl: number
}
const store = new Map<string, StubEntry>()
let throwOnSet: (key: string, opts?: { NX?: boolean; EX?: number }) => boolean
let setCallCount = 0
let incrCallCount = 0
let decrCallCount = 0

function makeRedisStub() {
  return {
    async get(key: string): Promise<string | null> {
      const e = store.get(key)
      return e ? e.value : null
    },
    async set(
      key: string,
      value: string,
      opts?: { NX?: boolean; EX?: number },
    ): Promise<string | null> {
      setCallCount++
      if (throwOnSet(key, opts)) {
        throw new Error("ECONNRESET — Redis blip mid-park SET")
      }
      const exists = store.has(key)
      if (opts?.NX && exists) return null
      store.set(key, { value, ttl: opts?.EX ?? -1 })
      return "OK"
    },
    async del(key: string): Promise<number> {
      const had = store.delete(key)
      return had ? 1 : 0
    },
    async incr(key: string): Promise<number> {
      incrCallCount++
      const e = store.get(key)
      const n = e ? Number.parseInt(e.value, 10) + 1 : 1
      store.set(key, { value: String(n), ttl: e?.ttl ?? -1 })
      return n
    },
    async decr(key: string): Promise<number> {
      decrCallCount++
      const e = store.get(key)
      const n = e ? Number.parseInt(e.value, 10) - 1 : -1
      store.set(key, { value: String(n), ttl: e?.ttl ?? -1 })
      return n
    },
    async expire(key: string, seconds: number): Promise<number> {
      const e = store.get(key)
      if (!e) return 0
      store.set(key, { value: e.value, ttl: seconds })
      return 1
    },
  }
}

function rk(key: string): string {
  return `test:${key}`
}

import { parkDeferredIntentWithNxGuard } from "../park-nx.js"

function buildArgs(opts: { sessionId: string; nonce: string }) {
  const envelope = buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_" + opts.nonce },
    actor: { sessionId: opts.sessionId, principal: "llm" },
    taint: "UNTRUSTED",
    nonce: opts.nonce,
  })
  return {
    envelope: {
      intentHash: envelope.intentHash,
      kind: envelope.kind,
      actor: { sessionId: envelope.actor.sessionId },
      payload: envelope.payload,
      version: envelope.version,
      nonce: envelope.nonce,
      taint: envelope.taint,
      actorPrincipal: envelope.actor.principal,
    },
    signal: "payment.confirmed",
    ttlSeconds: 60,
    redis: makeRedisStub(),
    rk,
  }
}

describe("parkDeferredIntentWithNxGuard — P1-8 quota counter leak fix", () => {
  beforeEach(() => {
    store.clear()
    setCallCount = 0
    incrCallCount = 0
    decrCallCount = 0
    // Default: no throws.
    throwOnSet = () => false
  })

  it("[P1-8] DECRs the quota counter when the framework's mid-park SET throws", async () => {
    const sessionId = "sess_p1_8"
    const args = buildArgs({ sessionId, nonce: "P1_8" })

    const counterKey = rk(deferCounterKey(sessionId))
    const parkKey = rk(deferParkKey(sessionId))

    // Throw only on the framework's blob SET (not the NX placeholder SET).
    // The NX placeholder is the FIRST set call (with NX:true); the framework's
    // SET is the SECOND set call (no NX, just EX). We distinguish by NX flag.
    throwOnSet = (_key, opts) =>
      opts?.NX !== true && _key === parkKey

    // Pre-condition: no counter, no park.
    expect(store.get(counterKey)).toBeUndefined()
    expect(store.get(parkKey)).toBeUndefined()

    await expect(parkDeferredIntentWithNxGuard(args)).rejects.toThrow(
      /ECONNRESET/,
    )

    // The wrapper's NX placeholder SET ran (call 1).
    // The framework's INCR ran (call 1).
    // The framework's SET threw (call 2 in setCallCount).
    // The wrapper's catch block then:
    //   - DEL'd the NX placeholder
    //   - DECR'd the counter — THE FIX.
    expect(incrCallCount).toBe(1)
    expect(decrCallCount).toBe(1)

    // Post-condition: the counter is back to 0 (or absent — DECR from 1
    // yields 0, leaving the key present). Either way it is NOT leaked at
    // a positive value that would cap the session out.
    const counterEntry = store.get(counterKey)
    // After INCR (counter=1) + DECR (counter=0), the slot is reclaimed.
    expect(counterEntry?.value).toBe("0")

    // The placeholder was cleaned up so subsequent DEFERs can NX-acquire.
    expect(store.get(parkKey)).toBeUndefined()
  })

  it("[P1-8] does NOT DECR on the happy path — counter reflects live parks", async () => {
    // Sanity guard: the DECR fix must fire ONLY on the catch path, not on
    // every park. A spurious DECR would under-count live parks and let a
    // session burst past quota.
    const sessionId = "sess_p1_8_happy"
    const args = buildArgs({ sessionId, nonce: "HAPPY" })

    const result = await parkDeferredIntentWithNxGuard(args)
    expect(result.parked).toBe(true)

    // The framework INCR ran once; no compensating DECR.
    expect(incrCallCount).toBe(1)
    expect(decrCallCount).toBe(0)

    const counterEntry = store.get(rk(deferCounterKey(sessionId)))
    expect(counterEntry?.value).toBe("1")
  })
})
