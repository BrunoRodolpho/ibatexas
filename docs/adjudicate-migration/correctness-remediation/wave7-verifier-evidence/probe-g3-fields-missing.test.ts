// Probe G3: confirm what happens when caller omits version/nonce/taint at top-level.
// The W7-G3 adapter only hoists actorPrincipal. If the caller passes the
// envelope without ALSO providing version/nonce/taint at the top level,
// the parked blob is missing those fields and tamper detection is DISABLED.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
  return `w7-g3-probe:${key}`
}

function makeRedis(client: RedisTestHarness["client"]): any {
  return {
    incr: (key: string) => client.incr(key),
    decr: (key: string) => client.decr(key),
    expire: (key: string, seconds: number) => client.expire(key, seconds),
    set: (key: string, value: string, options: any) =>
      client.set(key, value, {
        ...(options?.EX !== undefined ? { EX: options.EX } : {}),
        ...(options?.NX ? { NX: true } : {}),
      }),
    del: (key: string) => client.del(key),
    get: (key: string) => client.get(key),
  }
}

describe.skipIf(!RUN_REAL_REDIS)(
  "PROBE G3 — verifies the hoist is incomplete for non-actorPrincipal fields",
  () => {
    let harness: RedisTestHarness

    beforeAll(async () => {
      harness = await setupRedisTestContainer()
    }, 90_000)

    afterAll(async () => {
      await harness?.teardown()
    })

    it("ADVERSARY: caller omits version/nonce/taint at top level — verification returns missing_fields (tamper-detection structurally disabled)", async () => {
      const sessionId = "probe_no_top_fields"
      const redis = makeRedis(harness.client)
      const envelope = buildEnvelope({
        kind: "order.cancel",
        payload: { orderId: "ord_PROBE" },
        actor: { sessionId, principal: "llm" },
        taint: "UNTRUSTED",
        nonce: "PROBE-NO-TOP",
      }) as IntentEnvelope

      // Pass envelope WITHOUT top-level version/nonce/taint.
      // Only actorPrincipal will be auto-hoisted by the W7-G3 adapter.
      const result = await parkDeferredIntentWithNxGuard({
        envelope: {
          intentHash: envelope.intentHash,
          kind: envelope.kind,
          actor: envelope.actor as any,
          payload: envelope.payload,
          // version, nonce, taint deliberately omitted at top level
        } as any,
        signal: "payment.confirmed",
        ttlSeconds: 60,
        redis,
        rk,
      })
      expect(result.parked).toBe(true)

      const raw = await harness.client.get(rk(deferParkKey(sessionId)))
      const parked = JSON.parse(raw as string) as ParkedEnvelope

      // The hoist filled in actorPrincipal automatically, but the other
      // three fields are still missing.
      expect(parked.envelope.actorPrincipal).toBe("llm")
      expect(parked.envelope.version).toBeUndefined()
      expect(parked.envelope.nonce).toBeUndefined()
      expect(parked.envelope.taint).toBeUndefined()

      const verification = verifyParkedEnvelopeHash(parked)
      // CRITICAL: this returns missing_fields, NOT verified:true.
      // Tamper-at-rest detection is DISABLED for this caller pattern.
      expect(verification.verified).toBeNull()
      if (verification.verified === null) {
        expect(verification.reason).toBe("missing_fields")
      }
    })
  },
)
