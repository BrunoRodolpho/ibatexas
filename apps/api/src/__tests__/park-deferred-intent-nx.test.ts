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
// Uses a REAL Redis against the SHARED testcontainer harness
// (`helpers/redis-testcontainer.ts`), same as the rest of the real-Redis
// suites. It previously gated on its OWN `REDIS_TEST_URL` env check, which
// is unset in CI — so the three cases below skipped silently and the file
// still reported green (measured on dev @ 2f5c4979: "park-deferred-intent-
// nx.test.ts (4 tests | 3 skipped)"). M0 of the multi()/eval ruling
// (docs/architecture/redis-lua-testing-decision.md, Q1) retired that gate:
// there is now exactly ONE real-Redis knob, `IBX_SKIP_REAL_REDIS=1`, it is
// local-dev-only, and `scripts/check-real-redis-suites.mjs` fails CI if the
// cases below do not actually execute.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { deferParkKey } from "@adjudicate/runtime"
import {
  parkDeferredIntentWithNxGuard,
  type ParkDeferredIntentNxResult,
} from "../adapters/park-deferred-intent-nx.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

type RedisClient = RedisTestHarness["client"]

function rk(key: string): string {
  return `test-park-nx:${key}`
}

// The framework's ParkRedis interface needs incr/decr/expire/set. The node-redis
// v4 client exposes all of these as methods returning Promise<...>; we just
// re-export the methods unchanged.
function makeParkRedis(client: RedisClient): {
  incr: (key: string) => Promise<number>
  decr: (key: string) => Promise<number>
  expire: (key: string, seconds: number, mode?: "NX") => Promise<unknown>
  set: (
    key: string,
    value: string,
    options: { EX?: number; NX?: boolean },
  ) => Promise<string | null>
  del: (key: string) => Promise<unknown>
  get: (key: string) => Promise<string | null>
} {
  return {
    incr: (key) => client.incr(key),
    decr: (key) => client.decr(key),
    expire: (key, seconds) => client.expire(key, seconds),
    set: (key, value, options) =>
      client.set(key, value, {
        ...(options.EX !== undefined ? { EX: options.EX } : {}),
        ...(options.NX ? { NX: true } : {}),
      }) as Promise<string | null>,
    del: (key) => client.del(key),
    get: (key) => client.get(key),
  }
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
  let harness: RedisTestHarness
  let client: RedisClient

  // 120s: a COLD `redis:7-alpine` pull on a CI runner can outlast the
  // package-wide 30s hookTimeout (apps/api/vitest.config.ts). The harness
  // itself allows 60s for container startup alone.
  beforeAll(async () => {
    harness = await setupRedisTestContainer()
    client = harness.client
  }, 120_000)

  afterAll(async () => {
    await harness?.teardown()
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
