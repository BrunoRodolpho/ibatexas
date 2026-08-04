// P0-7-TRUE — adversarial test for the NX-guarded park wrapper.
//
// Reproduces the data-loss class flagged by the deep audit: the framework's
// `parkDeferredIntent` performs a plain `redis.set(EX)` without NX, so a second
// DEFER for the same `sessionId` silently overwrites the first parked envelope.
//
// This test calls `parkDeferredIntentWithNxGuard` concurrently with two
// different envelopes for the same `sessionId` and asserts:
//
//   1. Exactly one call returns `{parked: true}`; the other returns
//      `{parked: false, reason: "collision"}`.
//   2. The blob preserved in Redis belongs to the WINNER (first writer),
//      not the loser — verifying no overwrite occurred.
//
// Uses a REAL Redis client against a testcontainer. Gate matches the rest
// of the apps/api Redis-backed tests (otp-brute-force, refund-drip-cap, …):
// set `REDIS_TEST_URL=redis://localhost:6380` and run
// `docker run --rm -d -p 6380:6379 --name w1c-redis redis:7-alpine` first.
// Suite is skipped when REDIS_TEST_URL is not set (was previously defaulting
// to localhost:6379 which surfaces `NOAUTH Authentication required` on dev
// machines that run a system Redis with auth — this masked the real intent
// that the suite is a containerised concurrency probe, not a unit test).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createClient } from "redis"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { deferParkKey } from "@adjudicate/runtime"
import {
  createParkRedisCapabilities,
  parkDeferredIntentWithNxGuard,
  type ParkDeferredIntentNxResult,
  type ParkRedisCapabilities,
} from "../adapters/park-deferred-intent-nx.js"

type RedisClient = ReturnType<typeof createClient>

const REDIS_URL = process.env.REDIS_TEST_URL
const RUN_REAL_REDIS = REDIS_URL !== undefined && REDIS_URL.length > 0

function rk(key: string): string {
  return `test-park-nx:${key}`
}

// F-22: the wrapper takes a COMPOSITION-VALIDATED surface, not a bare client.
// This used to be a hand-written shim that re-exported incr/decr/expire/set/
// del/get; that shim carried no `eval`, so the wrapper's old feature-detect
// missed and every park here exercised the plain-`del` "legacy" branch. Routing
// the real node-redis client through the production factory means these tests
// now drive the real Lua (compare-and-delete release, atomic quota check) on a
// real server — which is the only place that atomicity is observable at all.
function makeParkRedis(client: RedisClient): ParkRedisCapabilities {
  return createParkRedisCapabilities(client)
}

function buildTestEnvelope(args: {
  sessionId: string
  intentHash?: string
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

describe.skipIf(!RUN_REAL_REDIS)("P0-7-TRUE — parkDeferredIntentWithNxGuard", () => {
  let client: RedisClient

  beforeAll(async () => {
    client = createClient({ url: REDIS_URL })
    client.on("error", () => {
      /* swallow */
    })
    await client.connect()
  })

  afterAll(async () => {
    await client.quit().catch(() => {})
  })

  beforeEach(async () => {
    // Wipe namespace before each test so prior runs don't bleed
    const keys: string[] = []
    for await (const key of client.scanIterator({ MATCH: "test-park-nx:*" })) {
      // node-redis v4 scanIterator yields a string-or-array depending on version.
      if (Array.isArray(key)) {
        for (const k of key as string[]) keys.push(k)
      } else {
        keys.push(key as string)
      }
    }
    if (keys.length > 0) {
      await client.del(keys)
    }
  })

  afterEach(async () => {
    // belt and suspenders: clear again
    const keys: string[] = []
    for await (const key of client.scanIterator({ MATCH: "test-park-nx:*" })) {
      if (Array.isArray(key)) {
        for (const k of key as string[]) keys.push(k)
      } else {
        keys.push(key as string)
      }
    }
    if (keys.length > 0) {
      await client.del(keys)
    }
  })

  it("concurrent parks for the same sessionId — exactly one wins, the other gets collision", async () => {
    const sessionId = "sess_collision_test"
    const redis = makeParkRedis(client)

    const envA = buildTestEnvelope({ sessionId, nonce: "AAAA" })
    const envB = buildTestEnvelope({ sessionId, nonce: "BBBB" })

    // Concurrent park attempts with different nonces (hence different intentHashes
    // and different payload.orderId values).
    const [resultA, resultB] = await Promise.all<ParkDeferredIntentNxResult>([
      parkDeferredIntentWithNxGuard({
        envelope: {
          intentHash: envA.intentHash,
          kind: envA.kind,
          actor: { sessionId: envA.actor.sessionId },
          payload: envA.payload,
          version: envA.version,
          nonce: envA.nonce,
          taint: envA.taint,
          actorPrincipal: envA.actor.principal,
          origin: envA.origin,
        },
        signal: "payment.confirmed",
        ttlSeconds: 60,
        redis,
        rk,
      }),
      parkDeferredIntentWithNxGuard({
        envelope: {
          intentHash: envB.intentHash,
          kind: envB.kind,
          actor: { sessionId: envB.actor.sessionId },
          payload: envB.payload,
          version: envB.version,
          nonce: envB.nonce,
          taint: envB.taint,
          actorPrincipal: envB.actor.principal,
          origin: envB.origin,
        },
        signal: "payment.confirmed",
        ttlSeconds: 60,
        redis,
        rk,
      }),
    ])

    const parkedResults = [resultA, resultB].filter((r) => r.parked === true)
    const collisionResults = [resultA, resultB].filter(
      (r) => r.parked === false && r.reason === "collision",
    )

    // Exactly one parks, exactly one collides.
    expect(parkedResults).toHaveLength(1)
    expect(collisionResults).toHaveLength(1)

    // Verify the parked blob in Redis matches the WINNER's envelope.
    const parkKey = rk(deferParkKey(sessionId))
    const raw = await client.get(parkKey)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string) as {
      envelope: { intentHash: string; nonce: string; payload: { orderId: string } }
    }

    // Identify which envelope won.
    const winnerHash = (resultA.parked ? envA : envB).intentHash
    const winnerNonce = (resultA.parked ? envA : envB).nonce
    expect(stored.envelope.intentHash).toBe(winnerHash)
    expect(stored.envelope.nonce).toBe(winnerNonce)

    // Critically: it must NOT be the placeholder, and it must NOT be the loser.
    expect((stored as unknown as Record<string, unknown>).__nx_placeholder__).toBeUndefined()
    const loserHash = (resultA.parked ? envB : envA).intentHash
    expect(stored.envelope.intentHash).not.toBe(loserHash)
  })

  it("sequential parks: second attempt for same sessionId returns collision, first envelope preserved", async () => {
    const sessionId = "sess_sequential_test"
    const redis = makeParkRedis(client)

    const envA = buildTestEnvelope({ sessionId, nonce: "FIRST" })
    const envB = buildTestEnvelope({ sessionId, nonce: "SECOND" })

    const resultA = await parkDeferredIntentWithNxGuard({
      envelope: {
        intentHash: envA.intentHash,
        kind: envA.kind,
        actor: { sessionId: envA.actor.sessionId },
        payload: envA.payload,
        version: envA.version,
        nonce: envA.nonce,
        taint: envA.taint,
        actorPrincipal: envA.actor.principal,
        origin: envA.origin,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })

    const resultB = await parkDeferredIntentWithNxGuard({
      envelope: {
        intentHash: envB.intentHash,
        kind: envB.kind,
        actor: { sessionId: envB.actor.sessionId },
        payload: envB.payload,
        version: envB.version,
        nonce: envB.nonce,
        taint: envB.taint,
        actorPrincipal: envB.actor.principal,
        origin: envB.origin,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })

    expect(resultA.parked).toBe(true)
    expect(resultB.parked).toBe(false)
    if (resultB.parked === false) {
      expect(resultB.reason).toBe("collision")
    }

    // Verify the first envelope's payload survived.
    const parkKey = rk(deferParkKey(sessionId))
    const raw = await client.get(parkKey)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string) as {
      envelope: { intentHash: string; nonce: string }
    }
    expect(stored.envelope.intentHash).toBe(envA.intentHash)
    expect(stored.envelope.nonce).toBe("FIRST")
  })

  it("after first park resolves (key deleted), a new park can claim the slot", async () => {
    const sessionId = "sess_releaseable_test"
    const redis = makeParkRedis(client)

    const envA = buildTestEnvelope({ sessionId, nonce: "RELA" })
    const envB = buildTestEnvelope({ sessionId, nonce: "RELB" })

    const resultA = await parkDeferredIntentWithNxGuard({
      envelope: {
        intentHash: envA.intentHash,
        kind: envA.kind,
        actor: { sessionId: envA.actor.sessionId },
        payload: envA.payload,
        version: envA.version,
        nonce: envA.nonce,
        taint: envA.taint,
        actorPrincipal: envA.actor.principal,
        origin: envA.origin,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })
    expect(resultA.parked).toBe(true)

    // Simulate the resume path deleting the park key.
    await client.del(rk(deferParkKey(sessionId)))

    const resultB = await parkDeferredIntentWithNxGuard({
      envelope: {
        intentHash: envB.intentHash,
        kind: envB.kind,
        actor: { sessionId: envB.actor.sessionId },
        payload: envB.payload,
        version: envB.version,
        nonce: envB.nonce,
        taint: envB.taint,
        actorPrincipal: envB.actor.principal,
        origin: envB.origin,
      },
      signal: "payment.confirmed",
      ttlSeconds: 60,
      redis,
      rk,
    })
    expect(resultB.parked).toBe(true)
  })
})

describe("P0-7-TRUE — synthetic guard", () => {
  it("documents the real-Redis test gating", () => {
    if (!RUN_REAL_REDIS) {
      // eslint-disable-next-line no-console
      console.warn(
        "[P0-7-TRUE] REDIS_TEST_URL not set; skipping real-Redis park-NX concurrency tests. " +
          "Run docker run --rm -d -p 6380:6379 --name w1c-redis redis:7-alpine " +
          "and REDIS_TEST_URL=redis://localhost:6380 pnpm vitest to exercise.",
      )
    }
    expect(typeof RUN_REAL_REDIS).toBe("boolean")
  })
})
