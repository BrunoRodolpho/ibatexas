// audit-2026-05-24 — Hardening test T5: DEFER+resume audit-chain integrity.
// REAL REDIS.
//
// # Why this test exists
//
// SYNTHESIS.md §P1-5: the defer-resolver's resume audit record did NOT
// carry `supersedes` linking the resumed envelope back to the original
// parked intent. Replay tools couldn't chain `DEFER → resume` via
// `record.supersedes.predecessorIntentHash`. Fix landed in commit 40f0813.
//
// This test is the regression catch-net for the FULL chain — it exercises
// the wrapper-park → resolver-resume path end-to-end and asserts:
//   - parked intentHash in Redis == original envelope intentHash
//   - post-resume audit record's `supersedes.predecessorIntentHash` ==
//     original parked intentHash
//   - `supersedes.reason` == "defer_resumed"
//   - `supersedes.predecessorAt` == park timestamp
//
// Neighbouring unit test (defer-resolver.test.ts §[P1-5]) covers the
// resolver-side wiring with a hand-built parked blob; THIS test additionally
// exercises the REAL `parkDeferredIntentWithNxGuard` (so a regression in
// EITHER the wrapper OR the resolver's supersedes threading surfaces here).
//
// # Why the Redis substrate is a container (Phase 5, the F-22-deferred pair)
//
// This file used to drive a hand-rolled in-memory Redis stub. R5-S12 tried to
// move it onto the canonical in-memory adapter and all 3 cases died:
//
//     UnroutedRedisCall: [in-memory-redis] unrouted call: evalIncrCheck
//       at parkDeferredIntent (@adjudicate/runtime/src/defer-park.ts:231)
//
// `@adjudicate/runtime`'s `parkDeferredIntent` feature-detects
// `typeof args.redis.evalIncrCheck === "function"`, which the adapter's
// throw-on-access Proxy turns into a throw. F-22 makes that probe
// DETERMINISTIC here — every park composes through
// `createParkRedisCapabilities()`, on which `evalIncrCheck` is a REQUIRED
// member — but it does not make an in-memory home honest: `evalIncrCheck` and
// the placeholder release are Lua, and a JS implementation of either decides
// in our own process the very comparison the script exists to make atomic
// (W4 RULE 3; `docs/architecture/redis-lua-testing-decision.md`). So the park
// path's atomic branch gets its real substrate here, and these audit-chain
// assertions now run over it: the park's quota claim is a real `EVAL`, the
// resolver's `defer:resuming:*` release is a real compare-and-delete, and the
// blob this file reads back is bytes Redis actually stored.
//
// Two fictions die with the stub, both recorded in the census:
//   • the faked `rk` (`test:`) — the real `rk()` under apps/api's vitest
//     resolves to `development:`, so every key here was previously in a
//     namespace production never uses. `rk` is now the real one, shared by
//     this file's assertions and by the resolver's own key construction.
//   • the release EVAL that the stub did not implement. R5-S12 measured the
//     consequence — after a fully GREEN resume the `defer:resuming:*` mutex
//     was never cleared. Case 1 now asserts it IS.
//
// Harness idiom follows `src/__tests__/park-nx-release-failure-mode.test.ts`
// (the F-22 suite). Enrolled in `scripts/check-real-redis-suites.mjs`.
//
// Mocked layers: NATS (no-op), kernel adjudicate() (returns EXECUTE so
// dispatch + audit emit fires), the audit sink (the assertion vehicle), and
// `getRedisClient` — redirected at the CONTAINER, not at a double, so the one
// un-threaded singleton consumer on this path (`subscribers/dlq.ts`, reached
// by the tamper case) writes to the same real keyspace.

import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { deferParkKey, deferResumeHash } from "@adjudicate/runtime"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"
import { rk } from "@ibatexas/tools"
import {
  createParkRedisCapabilities,
  type ParkRedisCapabilities,
} from "../../adapters/park-deferred-intent-nx.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "../helpers/redis-testcontainer.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn())
const mockAdjudicate = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureMessage = vi.hoisted(() => vi.fn())
const mockSentryCaptureException = vi.hoisted(() => vi.fn())

/** Assigned in `beforeAll`; read only when a SUT resolves the singleton. */
let containerClient: RedisTestHarness["client"] | null = null

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
  publishNatsEvent: mockPublishNatsEvent,
}))

// PARTIAL mock — `rk` and everything else stay REAL. Only the singleton
// resolution is redirected, so a module on this path that has not been
// threaded a client (`subscribers/dlq.ts`) still lands in the container
// instead of reaching for a developer's local Redis.
vi.mock("@ibatexas/tools", async () => {
  const actual =
    await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools")
  return {
    ...actual,
    getRedisClient: vi.fn(async () => containerClient),
  }
})

// WS5 (claustrum-on-dev): the NX park guard moved to
// `apps/api/src/adapters/park-nx.ts`. This test parks via the real wrapper
// pulled in by `await import("../adapters/park-deferred-intent-nx.js")` (the
// apps/api seam → that new home; NOT the old
// `packages/llm-provider/src/park-nx.js` path), and resolves via the SUT.
//
// The SUT reads `getAuditSink` from `@ibatexas/audit-sink` and
// `orderPolicyBundle` from `@ibatexas/pack-orders` — NOT from
// `@ibatexas/llm-provider`. So the audit spy is installed on
// `@ibatexas/audit-sink` (the real `getAuditSink()` is fail-closed before boot
// wiring). The `orderPolicyBundle` is inert here because `adjudicate` is mocked.
vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({
    emit: mockGetAuditSinkEmit,
  }),
}))

vi.mock("@ibatexas/pack-orders", () => ({
  ordersPolicyBundle: {},
}))

vi.mock("@adjudicate/core/kernel", async () => {
  const real = await vi.importActual<typeof import("@adjudicate/core/kernel")>(
    "@adjudicate/core/kernel",
  )
  return {
    ...real,
    adjudicate: mockAdjudicate,
  }
})

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope,
  captureMessage: mockSentryCaptureMessage,
  captureException: mockSentryCaptureException,
  init: vi.fn(),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function paymentConfirmedEvent(
  overrides: Partial<PaymentStatusChangedEvent> = {},
): PaymentStatusChangedEvent {
  return {
    orderId: "order_42",
    paymentId: "pay_42",
    previousStatus: "payment_pending",
    newStatus: "paid",
    method: "pix",
    version: 2,
    timestamp: "2025-01-01T00:05:00.000Z",
    ...overrides,
  } as PaymentStatusChangedEvent
}

function makeLogger(): import("fastify").FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  } as unknown as import("fastify").FastifyBaseLogger
}

/**
 * Build an envelope. The NX wrapper hoists `actor.principal` →
 * `actorPrincipal` automatically; we only need to ensure the other three
 * verification fields (version, nonce, taint) are present, which
 * `buildEnvelope` populates.
 */
function buildTestEnvelope(args: {
  sessionId: string
  nonce: string
  payload?: unknown
}): IntentEnvelope {
  return buildEnvelope({
    kind: "order.confirm",
    payload: args.payload ?? { orderId: "order_42" },
    actor: { principal: "user", sessionId: args.sessionId },
    taint: "UNTRUSTED",
    nonce: args.nonce,
  }) as IntentEnvelope
}

/** The parked blob, as Redis actually holds it. */
interface ParkedBlobShape {
  envelope: { intentHash: string; payload: { orderId: string } }
  signal: string
  parkedAt: string
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_REAL_REDIS)(
  "audit-2026-05-24 T5 — DEFER+resume audit-chain integrity (real Redis)",
  () => {
    let harness: RedisTestHarness
    /** The PRODUCTION composition root, over a real client. */
    let parkRedis: ParkRedisCapabilities

    beforeAll(async () => {
      harness = await setupRedisTestContainer()
      containerClient = harness.client
      parkRedis = createParkRedisCapabilities(harness.client)
    }, 120_000)

    afterAll(async () => {
      containerClient = null
      await harness?.teardown()
    })

    beforeEach(async () => {
      await harness.client.flushAll()
      mockGetAuditSinkEmit.mockReset()
      mockAdjudicate.mockReset()
      mockSubscribeNatsEvent.mockReset()
      mockPublishNatsEvent.mockReset()
      mockSentryWithScope.mockReset()
      mockSentryCaptureException.mockReset()
      mockSentryCaptureMessage.mockReset()
    })

    it("park-then-resume preserves the original intentHash and threads `supersedes` correctly", async () => {
      // ─── Step 1: Build envelope; snapshot intentHash ─────────────────
      const sessionId = "sess_t5_integrity"
      const envelope = buildTestEnvelope({
        sessionId,
        nonce: "t5-nonce-1",
      })
      const originalIntentHash = envelope.intentHash
      expect(originalIntentHash).toBeTruthy()

      // ─── Step 2: Park via the production NX-guarded wrapper (P0-1) ───
      // WS5: park via the new apps/api home (real wrapper, unmocked).
      const { parkDeferredIntentWithNxGuard } = await import(
        "../../adapters/park-deferred-intent-nx.js"
      )
      const parkResult = await parkDeferredIntentWithNxGuard({
        envelope,
        signal: "payment.confirmed",
        ttlSeconds: 600,
        redis: parkRedis,
        rk,
        quotaPerSession: 5,
      })
      expect(parkResult).toEqual({ parked: true, count: expect.any(Number) })

      // ─── Step 3: Read parked blob; assert intentHash invariance ──────
      // If the wrapper / framework silently mutates the envelope before
      // store, the hash diverges and tamper-at-rest detection breaks.
      const parkedKey = rk(deferParkKey(sessionId))
      const rawBlob = await harness.client.get(parkedKey)
      expect(rawBlob).toBeTruthy()
      const parkedBlob = JSON.parse(rawBlob as string) as ParkedBlobShape
      expect(parkedBlob.envelope.intentHash).toBe(originalIntentHash)
      expect(parkedBlob.signal).toBe("payment.confirmed")
      const parkedAt = parkedBlob.parkedAt
      expect(parkedAt).toBeTruthy()

      // ─── Step 4: Resume via resolveDeferredSession ─────────────────────
      //
      // Mock the kernel to return EXECUTE so the resolver dispatches
      // and the audit emit fires.
      mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

      const { resolveDeferredSession, setResumeIntentDispatcher } =
        await import("../../subscribers/defer-resolver.js")
      const dispatcher = vi.fn(async () => undefined)
      setResumeIntentDispatcher(dispatcher)

      const result = await resolveDeferredSession({
        sessionId,
        signal: "payment.confirmed",
        event: paymentConfirmedEvent(),
        log: makeLogger(),
      })

      expect(result.kind).toBe("re_adjudicated")
      expect(dispatcher).toHaveBeenCalledOnce()

      // ─── Step 5: Capture audit record; assert chain integrity ────────
      expect(mockGetAuditSinkEmit).toHaveBeenCalledOnce()
      const record = (mockGetAuditSinkEmit.mock.calls as unknown as Array<
        [unknown]
      >)[0]![0] as {
        envelope: { intentHash: string; kind: string }
        supersedes?: {
          predecessorIntentHash: string
          predecessorAt: string
          reason: string
        }
      }

      // The resume record's envelope is the SAME envelope we parked.
      expect(record.envelope.intentHash).toBe(originalIntentHash)
      expect(record.envelope.kind).toBe(envelope.kind)

      // The supersedes chain — load-bearing assertion for P1-5.
      expect(record.supersedes).toBeTruthy()
      expect(record.supersedes!.predecessorIntentHash).toBe(originalIntentHash)
      expect(record.supersedes!.predecessorAt).toBe(parkedAt)
      expect(record.supersedes!.reason).toBe("defer_resumed")

      // ─── Step 6 (added by the real-Redis migration) ──────────────────
      // The resolver's `defer:resuming:*` mutex is released by a Lua
      // compare-and-delete. Over the retired stub — which had no `eval` —
      // the release threw and was swallowed by its best-effort catch, so the
      // marker survived a fully GREEN resume (R5-S12's measured bound, the
      // hole this migration closes). On real Redis the CAD runs.
      const resumingKey = rk(
        `defer:resuming:${deferResumeHash(originalIntentHash, "payment.confirmed")}`,
      )
      expect(await harness.client.exists(resumingKey)).toBe(0)

      setResumeIntentDispatcher(null)
    })

    it("two parks-then-resumes produce distinct audit chains pinned to their own predecessors", async () => {
      // Two parks under different sessionIds must produce TWO distinct
      // audit chains, each pinned to its OWN predecessor. A regression
      // where the resolver threads A's predecessor into B's audit record
      // (or vice-versa) is the P1-5-cross-leak failure mode.
      mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })

      const sessionA = "sess_t5_A"
      const sessionB = "sess_t5_B"
      const envelopeA = buildTestEnvelope({
        sessionId: sessionA,
        nonce: "t5-nonce-A",
        payload: { orderId: "order_A" },
      })
      const envelopeB = buildTestEnvelope({
        sessionId: sessionB,
        nonce: "t5-nonce-B",
        payload: { orderId: "order_B" },
      })
      const hashA = envelopeA.intentHash
      const hashB = envelopeB.intentHash
      // Sanity: distinct nonce/payload MUST hash differently (smoke-check
      // on the kernel's intentHash derivation, not the audit chain).
      expect(hashA).not.toBe(hashB)

      // WS5: park via the new apps/api home (real wrapper, unmocked).
      const { parkDeferredIntentWithNxGuard } = await import(
        "../../adapters/park-deferred-intent-nx.js"
      )

      await parkDeferredIntentWithNxGuard({
        envelope: envelopeA,
        signal: "payment.confirmed",
        ttlSeconds: 600,
        redis: parkRedis,
        rk,
        quotaPerSession: 5,
      })
      await parkDeferredIntentWithNxGuard({
        envelope: envelopeB,
        signal: "payment.confirmed",
        ttlSeconds: 600,
        redis: parkRedis,
        rk,
        quotaPerSession: 5,
      })

      const parkedAtA = (
        JSON.parse(
          (await harness.client.get(rk(deferParkKey(sessionA)))) as string,
        ) as ParkedBlobShape
      ).parkedAt
      const parkedAtB = (
        JSON.parse(
          (await harness.client.get(rk(deferParkKey(sessionB)))) as string,
        ) as ParkedBlobShape
      ).parkedAt

      const { resolveDeferredSession, setResumeIntentDispatcher } =
        await import("../../subscribers/defer-resolver.js")
      setResumeIntentDispatcher(vi.fn(async () => undefined))

      const resA = await resolveDeferredSession({
        sessionId: sessionA,
        signal: "payment.confirmed",
        event: paymentConfirmedEvent({ orderId: "order_A" }),
        log: makeLogger(),
      })
      const resB = await resolveDeferredSession({
        sessionId: sessionB,
        signal: "payment.confirmed",
        event: paymentConfirmedEvent({ orderId: "order_B" }),
        log: makeLogger(),
      })

      expect(resA.kind).toBe("re_adjudicated")
      expect(resB.kind).toBe("re_adjudicated")
      expect(mockGetAuditSinkEmit).toHaveBeenCalledTimes(2)

      const calls = mockGetAuditSinkEmit.mock.calls as unknown as Array<
        [
          {
            envelope: { intentHash: string }
            supersedes?: {
              predecessorIntentHash: string
              predecessorAt: string
              reason: string
            }
          },
        ]
      >

      // Resolve which call corresponds to which session by intentHash —
      // assertion order is independent of call ordering.
      const recordForA = calls.find((c) => c[0].envelope.intentHash === hashA)
      const recordForB = calls.find((c) => c[0].envelope.intentHash === hashB)
      expect(recordForA).toBeTruthy()
      expect(recordForB).toBeTruthy()

      expect(recordForA![0].supersedes!.predecessorIntentHash).toBe(hashA)
      expect(recordForA![0].supersedes!.predecessorAt).toBe(parkedAtA)
      expect(recordForA![0].supersedes!.reason).toBe("defer_resumed")

      expect(recordForB![0].supersedes!.predecessorIntentHash).toBe(hashB)
      expect(recordForB![0].supersedes!.predecessorAt).toBe(parkedAtB)
      expect(recordForB![0].supersedes!.reason).toBe("defer_resumed")

      // Cross-check: A's chain MUST NOT point at B's predecessor (the
      // bug class P1-5 would catch).
      expect(recordForA![0].supersedes!.predecessorIntentHash).not.toBe(hashB)
      expect(recordForB![0].supersedes!.predecessorIntentHash).not.toBe(hashA)

      setResumeIntentDispatcher(null)
    })

    it("resume of a tampered park blob does NOT emit an audit record (negative test)", async () => {
      // Tampered blob → resolver DLQs + NO audit emit. Pins the contract
      // so a regression that "fixes" verify-hash and accidentally emits an
      // audit for a tampered envelope surfaces here.
      const sessionId = "sess_t5_tampered"
      const envelope = buildTestEnvelope({
        sessionId,
        nonce: "t5-nonce-tampered",
      })
      // WS5: park via the new apps/api home (real wrapper, unmocked).
      const { parkDeferredIntentWithNxGuard } = await import(
        "../../adapters/park-deferred-intent-nx.js"
      )
      await parkDeferredIntentWithNxGuard({
        envelope,
        signal: "payment.confirmed",
        ttlSeconds: 600,
        redis: parkRedis,
        rk,
        quotaPerSession: 5,
      })

      // Tamper the parked blob: flip a byte in the payload so the
      // verifier's derived hash diverges from the stored intentHash.
      // Written back with KEEPTTL so the tamper is at REST — the key keeps
      // the lifetime the park gave it, exactly as an adversary editing the
      // value in place would leave it.
      const parkedKey = rk(deferParkKey(sessionId))
      const blob = JSON.parse(
        (await harness.client.get(parkedKey)) as string,
      ) as ParkedBlobShape
      blob.envelope.payload.orderId = "order_TAMPERED"
      await harness.client.set(parkedKey, JSON.stringify(blob), {
        KEEPTTL: true,
      })
      expect(await harness.client.ttl(parkedKey)).toBeGreaterThan(0)

      mockAdjudicate.mockReturnValue({ kind: "EXECUTE" })
      const { resolveDeferredSession, setResumeIntentDispatcher } =
        await import("../../subscribers/defer-resolver.js")
      setResumeIntentDispatcher(vi.fn(async () => undefined))

      const result = await resolveDeferredSession({
        sessionId,
        signal: "payment.confirmed",
        event: paymentConfirmedEvent(),
        log: makeLogger(),
      })

      // Resolver detects tamper — either `park_blob_tampered` or
      // `park_blob_unverifiable` is acceptable; either way, NO audit emit.
      expect(
        result.kind === "park_blob_tampered" ||
          result.kind === "park_blob_unverifiable",
      ).toBe(true)
      expect(mockGetAuditSinkEmit).not.toHaveBeenCalled()

      setResumeIntentDispatcher(null)
    })
  },
)
