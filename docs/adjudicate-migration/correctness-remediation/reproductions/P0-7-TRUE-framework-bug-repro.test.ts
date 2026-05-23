// P0-7-TRUE — Reproduction test for the framework bug.
//
// This test exercises the framework's `parkDeferredIntent` primitive DIRECTLY
// (no NX wrapper) against a real Redis container. It demonstrates the data-loss
// class: two concurrent park calls for the same sessionId both succeed, with
// the second silently overwriting the first.
//
// This test is the "before" evidence — it should FAIL when run, proving the
// bug exists. The wrapper test in
// `apps/api/src/__tests__/park-deferred-intent-nx.test.ts` is the "after"
// evidence — using the NX-guarded wrapper, exactly one of the two concurrent
// parks wins.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createClient } from "redis"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { parkDeferredIntent, deferParkKey } from "@adjudicate/runtime"

type RedisClient = ReturnType<typeof createClient>

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

function rk(key: string): string {
  return `repro-p07:${key}`
}

function makeParkRedis(client: RedisClient) {
  return {
    incr: (key: string) => client.incr(key),
    decr: (key: string) => client.decr(key),
    expire: (key: string, seconds: number) => client.expire(key, seconds),
    set: (key: string, value: string, options: { EX: number }) =>
      client.set(key, value, { EX: options.EX }) as Promise<string | null>,
  }
}

function buildTestEnvelope(args: {
  sessionId: string
  nonce: string
}): IntentEnvelope {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_" + args.nonce },
    actor: { sessionId: args.sessionId, principal: "llm" },
    taint: "UNTRUSTED",
    nonce: args.nonce,
  }) as IntentEnvelope
}

describe("P0-7-TRUE REPRO — framework parkDeferredIntent has no NX", () => {
  let client: RedisClient

  beforeAll(async () => {
    client = createClient({ url: REDIS_URL })
    client.on("error", () => {})
    await client.connect()
  })

  afterAll(async () => {
    await client.quit().catch(() => {})
  })

  beforeEach(async () => {
    const keys: string[] = []
    for await (const key of client.scanIterator({ MATCH: "repro-p07:*" })) {
      if (Array.isArray(key)) {
        for (const k of key as string[]) keys.push(k)
      } else {
        keys.push(key as string)
      }
    }
    if (keys.length > 0) await client.del(keys)
  })

  it("EXPECTED TO FAIL — framework parkDeferredIntent allows the second park to overwrite the first", async () => {
    const sessionId = "sess_framework_bug"
    const redis = makeParkRedis(client)

    const envA = buildTestEnvelope({ sessionId, nonce: "FIRST" })
    const envB = buildTestEnvelope({ sessionId, nonce: "SECOND" })

    // Park envA first.
    const resultA = await parkDeferredIntent({
      envelope: {
        intentHash: envA.intentHash,
        kind: envA.kind,
        actor: { sessionId: envA.actor.sessionId },
        payload: envA.payload,
        version: envA.version,
        nonce: envA.nonce,
        taint: envA.taint,
        actorPrincipal: envA.actor.principal,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })
    expect(resultA.parked).toBe(true)

    // Park envB next — framework returns parked:true (no NX check).
    const resultB = await parkDeferredIntent({
      envelope: {
        intentHash: envB.intentHash,
        kind: envB.kind,
        actor: { sessionId: envB.actor.sessionId },
        payload: envB.payload,
        version: envB.version,
        nonce: envB.nonce,
        taint: envB.taint,
        actorPrincipal: envB.actor.principal,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })

    // BUG: framework allowed B to overwrite A. This expectation FAILS today.
    // Once a fix is in, the second park should be REJECTED.
    expect(resultB.parked).toBe(false)
  })

  it("EXPECTED TO PASS (proof of overwrite) — framework primitive overwrites the first envelope's blob", async () => {
    const sessionId = "sess_overwrite_proof"
    const redis = makeParkRedis(client)

    const envA = buildTestEnvelope({ sessionId, nonce: "FIRSTPROOF" })
    const envB = buildTestEnvelope({ sessionId, nonce: "SECONDPROOF" })

    await parkDeferredIntent({
      envelope: {
        intentHash: envA.intentHash,
        kind: envA.kind,
        actor: { sessionId: envA.actor.sessionId },
        payload: envA.payload,
        version: envA.version,
        nonce: envA.nonce,
        taint: envA.taint,
        actorPrincipal: envA.actor.principal,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })

    await parkDeferredIntent({
      envelope: {
        intentHash: envB.intentHash,
        kind: envB.kind,
        actor: { sessionId: envB.actor.sessionId },
        payload: envB.payload,
        version: envB.version,
        nonce: envB.nonce,
        taint: envB.taint,
        actorPrincipal: envB.actor.principal,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })

    // The parked blob is envelope B — envelope A was silently overwritten.
    const parkKey = rk(deferParkKey(sessionId))
    const raw = await client.get(parkKey)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string) as {
      envelope: { nonce: string }
    }
    expect(stored.envelope.nonce).toBe("SECONDPROOF") // proves overwrite
  })
})
