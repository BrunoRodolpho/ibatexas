// W7-G3 — integration test: parked envelope blob is hash-verifiable end-to-end.
//
// Wave 6 finding: the framework's `verifyParkedEnvelopeHash` reads
// `envelope.actorPrincipal` at top-level, but a careless adopter passing
// a raw `IntentEnvelope` (whose `actor.principal` is nested) would land
// every park in the `missing_fields` back-compat branch — tamper-at-rest
// detection structurally inert.
//
// W7-G3 hardens the NX-guard wrapper with a defensive hoist of
// `actor.principal` → top-level `actorPrincipal`. This integration test
// is the load-bearing proof:
//   1. Park a real envelope through `parkDeferredIntentWithNxGuard`
//      (the adopter wrapper).
//   2. Read the raw Redis blob directly via node-redis (NOT through the
//      framework's resume primitive — we want the unprocessed bytes).
//   3. Call `verifyParkedEnvelopeHash` from `@adjudicate/runtime` on the
//      parsed blob.
//   4. Assert the result is `{verified: true}` — NOT `{verified: null,
//      reason: "missing_fields"}` (the pre-W7-G3 failure mode).
//
// Uses the existing redis-testcontainer.ts harness (Docker). If Docker
// is unavailable, the suite is gated by RUN_REAL_REDIS — when
// `IBX_SKIP_REAL_REDIS=1` is set the suite is skipped (local dev
// convenience; CI must run the real container).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  deferParkKey,
  verifyParkedEnvelopeHash,
  type ParkedEnvelope,
} from "@adjudicate/runtime"
import { parkDeferredIntentWithNxGuard } from "../park-deferred-intent-nx.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "../../__tests__/helpers/redis-testcontainer.js"

function rk(key: string): string {
  return `w7-g3-park-hash:${key}`
}

// Map node-redis client → the ParkRedis interface the wrapper expects.
function makeParkRedis(client: RedisTestHarness["client"]): {
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

function buildTestEnvelope(args: { sessionId: string; nonce: string }): IntentEnvelope {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_" + args.nonce },
    actor: { sessionId: args.sessionId, principal: "llm" },
    taint: "UNTRUSTED",
    nonce: args.nonce,
  }) as IntentEnvelope
}

describe.skipIf(!RUN_REAL_REDIS)(
  "W7-G3 — verifyParkedEnvelopeHash on adopter-parked blob",
  () => {
    let harness: RedisTestHarness

    beforeAll(async () => {
      harness = await setupRedisTestContainer()
    }, 90_000)

    afterAll(async () => {
      await harness?.teardown()
    })

    beforeEach(async () => {
      // Wipe namespace between tests so prior runs don't bleed
      const keys: string[] = []
      for await (const key of harness.client.scanIterator({ MATCH: "w7-g3-park-hash:*" })) {
        if (Array.isArray(key)) {
          for (const k of key as string[]) keys.push(k)
        } else {
          keys.push(key as string)
        }
      }
      if (keys.length > 0) {
        await harness.client.del(keys)
      }
    })

    it("park-via-wrapper → read raw blob → verifyParkedEnvelopeHash returns {verified: true}", async () => {
      const sessionId = "sess_w7_g3_happy"
      const redis = makeParkRedis(harness.client)
      const envelope = buildTestEnvelope({ sessionId, nonce: "HOIST-OK" })

      // Park through the adopter wrapper with explicit top-level fields
      // (the kernel-executor / llm-responder shape).
      const result = await parkDeferredIntentWithNxGuard({
        envelope: {
          intentHash: envelope.intentHash,
          kind: envelope.kind,
          actor: { sessionId: envelope.actor.sessionId },
          payload: envelope.payload,
          version: envelope.version,
          nonce: envelope.nonce,
          taint: envelope.taint,
          actorPrincipal: envelope.actor.principal,
          origin: envelope.origin,
        },
        signal: "payment.confirmed",
        ttlSeconds: 60,
        redis,
        rk,
      })
      expect(result.parked).toBe(true)

      // Read the raw Redis blob directly via node-redis (NOT through the
      // framework's resume primitive — we want the unprocessed bytes).
      const raw = await harness.client.get(rk(deferParkKey(sessionId)))
      expect(raw).not.toBeNull()
      const parked = JSON.parse(raw as string) as ParkedEnvelope

      // Sanity: top-level fields the framework reads must be present.
      expect(parked.envelope.actorPrincipal).toBe("llm")
      expect(parked.envelope.version).toBe(envelope.version)
      expect(parked.envelope.nonce).toBe(envelope.nonce)
      expect(parked.envelope.taint).toBe(envelope.taint)

      // The contract: verifyParkedEnvelopeHash returns {verified: true}.
      const verification = verifyParkedEnvelopeHash(parked)
      expect(verification.verified).toBe(true)
    })

    it("hoist auto-corrects: caller passes envelope WITHOUT explicit top-level actorPrincipal — wrapper hoists from actor.principal", async () => {
      const sessionId = "sess_w7_g3_hoist"
      const redis = makeParkRedis(harness.client)
      const envelope = buildTestEnvelope({ sessionId, nonce: "HOIST-AUTO" })

      // Adversarial: pass a full IntentEnvelope shape (actor.principal
      // nested, NO top-level actorPrincipal). Pre-W7-G3 this would have
      // landed `missing_fields` at resume. Post-W7-G3 the wrapper hoists
      // actor.principal up automatically.
      const result = await parkDeferredIntentWithNxGuard({
        envelope: {
          intentHash: envelope.intentHash,
          kind: envelope.kind,
          // Full nested actor — emulates a caller passing IntentEnvelope.actor.
          actor: envelope.actor as unknown as { sessionId: string },
          payload: envelope.payload,
          version: envelope.version,
          nonce: envelope.nonce,
          taint: envelope.taint,
          origin: envelope.origin,
          // actorPrincipal deliberately omitted at the top level.
        },
        signal: "payment.confirmed",
        ttlSeconds: 60,
        redis,
        rk,
      })
      expect(result.parked).toBe(true)

      const raw = await harness.client.get(rk(deferParkKey(sessionId)))
      const parked = JSON.parse(raw as string) as ParkedEnvelope

      // The hoist auto-populated actorPrincipal even though the caller
      // omitted it explicitly.
      expect(parked.envelope.actorPrincipal).toBe("llm")

      const verification = verifyParkedEnvelopeHash(parked)
      // CONTRACT: verified, NOT missing_fields.
      expect(verification.verified).toBe(true)
    })

    it("tamper detection still works: mutating the payload after park yields verified=false", async () => {
      const sessionId = "sess_w7_g3_tamper"
      const redis = makeParkRedis(harness.client)
      const envelope = buildTestEnvelope({ sessionId, nonce: "TAMPER" })

      const result = await parkDeferredIntentWithNxGuard({
        envelope: {
          intentHash: envelope.intentHash,
          kind: envelope.kind,
          actor: { sessionId: envelope.actor.sessionId },
          payload: envelope.payload,
          version: envelope.version,
          nonce: envelope.nonce,
          taint: envelope.taint,
          actorPrincipal: envelope.actor.principal,
          origin: envelope.origin,
        },
        signal: "payment.confirmed",
        ttlSeconds: 60,
        redis,
        rk,
      })
      expect(result.parked).toBe(true)

      // Adversary mutates the parked payload at rest.
      const key = rk(deferParkKey(sessionId))
      const raw = await harness.client.get(key)
      const parked = JSON.parse(raw as string) as ParkedEnvelope
      const tampered = {
        ...parked,
        envelope: {
          ...parked.envelope,
          payload: { orderId: "ord_HIJACKED" },
        },
      }
      await harness.client.set(key, JSON.stringify(tampered))

      // Read back the tampered blob and verify.
      const tamperedRaw = await harness.client.get(key)
      const tamperedParked = JSON.parse(tamperedRaw as string) as ParkedEnvelope
      const verification = verifyParkedEnvelopeHash(tamperedParked)

      // Pre-W7-G3 (missing fields) would return verified:null. Post-W7-G3
      // the fields are present so the hash check runs and detects the
      // mismatch — verified:false with reason:"tampered".
      expect(verification.verified).toBe(false)
      if (verification.verified === false) {
        expect(verification.reason).toBe("tampered")
      }
    })
  },
)
