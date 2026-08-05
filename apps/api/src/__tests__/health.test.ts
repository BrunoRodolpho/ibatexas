// Integration tests for health route
// GET /health — returns status, version, timestamp, and the DLQ/outbox queue report.
//
// ── F-30: why this file's `@ibatexas/tools` mock is COMPLETE ─────────────────
// It used to mock `getRedisClient` ONLY. `../routes/health.ts` imports
// `{ getRedisClient, rk }`, so `rk` was missing from the mock and the very first
// `rk(...)` call inside `checkQueues` threw
//   [vitest] No "rk" export is defined on the "@ibatexas/tools" mock.
// straight into that function's swallowing `catch { /* non-fatal */ }`. MEASURED,
// not inferred: with an `lLen` spy wired onto the mocked client and the real
// handler driven, `lLen` was called ZERO times — the throw preceded every queue
// read — and v8 put line coverage of health.ts at 94.01% with lines 115 and
// 117-130 (the whole outbox loop plus the DLQ accumulate arm) never executed.
// The queue-checking path read green while being entirely unexercised.
//
// The mock now supplies the REAL `rk` (delegated via `importActual`, never a
// hand-rolled `${env}:${key}` mirror — a mirror would be a projection of the
// thing under test) and an `lLen` driven by a hand-written, per-test key→length
// table, so `checkQueues` actually runs. None of the nine pre-existing tests
// changed the value it observes; what changed is that "healthy" in the first
// test is now guaranteed by twelve genuinely-empty queues instead of by the
// swallowed throw. The queue behaviour itself is pinned in the
// "queue report (F-30)" block below.
//
// NOT covered here (that is `health-outbox-key.test.ts`, PR #536): which KEYS
// the route asks Redis for. This file covers what the handler DOES with the
// lengths that come back.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { healthRoutes } from "../routes/health.js"

// Per-test control over what Redis reports for each queue key. `lens` is keyed
// by the FULL Redis key; a key absent from the table reports length 0 (the
// "queue is empty" case). `lLenError`, when set, makes every queue read reject
// so the non-fatal catch can be exercised.
const { queueState } = vi.hoisted(() => ({
  queueState: {
    lens: new Map<string, number>(),
    lLenError: null as Error | null,
  },
}))

// Mock external dependencies so health checks pass in unit tests
vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools")
  return {
    // The real `rk` — its APP_ENV prefixing is what turns the suffixes below
    // into the full keys `lLen` is asked for. Pinned independently by #536.
    rk: actual.rk,
    getRedisClient: vi.fn(async () => ({
      ping: vi.fn(async () => "PONG"),
      lLen: vi.fn(async (key: string) => {
        if (queueState.lLenError) throw queueState.lLenError
        return queueState.lens.get(key) ?? 0
      }),
    })),
  }
})

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  getNatsConnection: vi.fn(async () => ({
    isClosed: vi.fn(() => false),
  })),
}))

// Mock global fetch for Typesense health check
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("GET /health", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = Fastify({ logger: false })
    await server.register(healthRoutes)
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  // Default for every test in this file: twelve empty queues, Redis healthy.
  beforeEach(() => {
    queueState.lens.clear()
    queueState.lLenError = null
  })

  it("returns 200 with status healthy when all dependencies are up", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe("healthy")
    expect(body.checks).toEqual({
      redis: "ok",
      postgres: "ok",
      nats: "ok",
      typesense: "ok",
    })
  })

  it("includes a version string", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    const body = response.json()
    expect(body.version).toBeDefined()
    expect(typeof body.version).toBe("string")
    // version should look like semver
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("includes an ISO 8601 timestamp", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    const body = response.json()
    expect(body.timestamp).toBeDefined()
    // Should be valid ISO date
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })

  it("returns 503 when critical dependency fails", async () => {
    // Make Redis fail
    const { getRedisClient } = await import("@ibatexas/tools")
    vi.mocked(getRedisClient).mockRejectedValueOnce(new Error("Redis down"))

    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(503)
    const body = response.json()
    expect(body.status).toBe("unhealthy")
    expect(body.checks.redis).toBe("fail")
  })

  it("returns 200 with degraded when non-critical dependency fails", async () => {
    // Make Typesense fail by mocking fetch to reject
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("Typesense down"))

    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe("degraded")
    expect(body.checks.typesense).toBe("fail")
    // Critical deps should still be ok
    expect(body.checks.redis).toBe("ok")
    expect(body.checks.postgres).toBe("ok")
  })

  // ── testFingerprint (T1a-10 environment handshake, D-010) ──────────────────
  // Present ONLY when IBX_TEST_FINGERPRINT is set in the process env (the
  // test profile sets it; dev/prod never do). Value = the env var's value.
  describe("testFingerprint", () => {
    const originalFingerprint = process.env.IBX_TEST_FINGERPRINT

    afterEach(() => {
      if (originalFingerprint === undefined) {
        delete process.env.IBX_TEST_FINGERPRINT
      } else {
        process.env.IBX_TEST_FINGERPRINT = originalFingerprint
      }
    })

    it("is absent when IBX_TEST_FINGERPRINT is not set", async () => {
      delete process.env.IBX_TEST_FINGERPRINT

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(200)
      expect(response.json()).not.toHaveProperty("testFingerprint")
    })

    it("is absent when IBX_TEST_FINGERPRINT is an empty string", async () => {
      process.env.IBX_TEST_FINGERPRINT = ""

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(200)
      expect(response.json()).not.toHaveProperty("testFingerprint")
    })

    it("exposes the env var's value when IBX_TEST_FINGERPRINT is set", async () => {
      process.env.IBX_TEST_FINGERPRINT = "test-fp-t1a10-handshake"

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(200)
      expect(response.json().testFingerprint).toBe("test-fp-t1a10-handshake")
    })

    it("is present even on a 503 unhealthy response (identity, not health)", async () => {
      process.env.IBX_TEST_FINGERPRINT = "test-fp-unhealthy"
      const { getRedisClient } = await import("@ibatexas/tools")
      vi.mocked(getRedisClient).mockRejectedValueOnce(new Error("Redis down"))

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(503)
      expect(response.json().testFingerprint).toBe("test-fp-unhealthy")
    })
  })

  // ── queue report (F-30) ────────────────────────────────────────────────────
  // `checkQueues` reads five DLQ lists and seven outbox lists, folds them into
  // `dlq` / `outbox` maps, and derives two flags that feed the degraded verdict:
  //   hasDlqEntries    — ANY dlq list with len > 0. No threshold.
  //   hasOutboxBacklog — ANY SINGLE outbox list with len > 100.
  // Both maps are spread onto the body only when non-empty.
  //
  // APP_ENV is pinned to a literal for this block so every expected key can be
  // written out in full below rather than computed from `rk()` — an expectation
  // built by calling the SUT's own key factory would agree with any key the
  // route happened to build, including a wrong one.
  describe("queue report (F-30)", () => {
    const originalAppEnv = process.env.APP_ENV

    beforeAll(() => {
      process.env.APP_ENV = "f30health"
    })

    afterAll(() => {
      if (originalAppEnv === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = originalAppEnv
    })

    // Hand-written full keys. NOT derived from the route's module-private
    // DLQ_EVENTS / OUTBOX_EVENTS arrays, and not from `rk`.
    const DLQ_ORDER_PLACED = "f30health:dlq:order.placed"
    const DLQ_NOTIFICATION_SEND = "f30health:dlq:notification.send"
    const OUTBOX_ORDER_PLACED = "f30health:outbox:order.placed"
    const OUTBOX_ORDER_CANCELED = "f30health:outbox:order.canceled"
    const OUTBOX_ORDER_DISPUTED = "f30health:outbox:order.disputed"

    async function get(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await server.inject({ method: "GET", url: "/health" })
      return { statusCode: response.statusCode, body: response.json() }
    }

    it("a DLQ entry of ANY size degrades the response, and only the non-empty lists are reported", async () => {
      queueState.lens.set(DLQ_ORDER_PLACED, 1)
      queueState.lens.set(DLQ_NOTIFICATION_SEND, 7)

      const { statusCode, body } = await get()

      // A single stuck message is enough — the DLQ flag carries no threshold.
      expect(statusCode).toBe(200)
      expect(body.status).toBe("degraded")
      // Exactly the two populated events: the other three DLQ lists returned 0
      // and must not appear as zero-valued noise.
      expect(body.dlq).toEqual({ "order.placed": 1, "notification.send": 7 })
      // Every outbox list was empty, so the outbox key is omitted entirely. The
      // `dlq` assertion directly above is this arm's during-arm: the queue path
      // demonstrably ran, so this absence is a real omission and not a report
      // that never happened.
      expect(body).not.toHaveProperty("outbox")
    })

    it("an outbox length of exactly 100 is reported but is NOT a backlog — the response stays healthy", async () => {
      queueState.lens.set(OUTBOX_ORDER_PLACED, 100)

      const { statusCode, body } = await get()

      expect(statusCode).toBe(200)
      // The count reached the body, so "healthy" here is a decision about the
      // threshold — not a queue report that silently never ran.
      expect(body.outbox).toEqual({ "order.placed": 100 })
      expect(body.status).toBe("healthy")
    })

    it("an outbox length of 101 crosses the backlog threshold and degrades the response", async () => {
      queueState.lens.set(OUTBOX_ORDER_PLACED, 101)

      const { statusCode, body } = await get()

      expect(statusCode).toBe(200)
      expect(body.outbox).toEqual({ "order.placed": 101 })
      expect(body.status).toBe("degraded")
    })

    it("the backlog threshold is per-event, not a total: two outbox lists of 60 (sum 120) stay healthy", async () => {
      queueState.lens.set(OUTBOX_ORDER_PLACED, 60)
      queueState.lens.set(OUTBOX_ORDER_CANCELED, 60)

      const { statusCode, body } = await get()

      expect(statusCode).toBe(200)
      expect(body.outbox).toEqual({ "order.placed": 60, "order.canceled": 60 })
      expect(body.status).toBe("healthy")
    })

    it("omits dlq and outbox entirely when every queue is empty (during-arm: both appear when populated)", async () => {
      // DURING-ARM — the same request shape with the queues populated, proving
      // the two keys are ones this endpoint really emits.
      queueState.lens.set(DLQ_ORDER_PLACED, 3)
      queueState.lens.set(OUTBOX_ORDER_DISPUTED, 5)
      const during = await get()
      expect(during.body.dlq).toEqual({ "order.placed": 3 })
      expect(during.body.outbox).toEqual({ "order.disputed": 5 })

      // ABSENCE ARM — same endpoint, every list empty.
      queueState.lens.clear()
      const after = await get()
      expect(after.statusCode).toBe(200)
      expect(after.body.status).toBe("healthy")
      expect(after.body).not.toHaveProperty("dlq")
      expect(after.body).not.toHaveProperty("outbox")
    })

    it("the queue check is non-fatal: a Redis failure inside checkQueues still answers 200 healthy (during-arm: the report is present when Redis works)", async () => {
      // DURING-ARM — Redis working, a populated DLQ, so we know the report is
      // something this endpoint produces and the failure arm below is a real
      // loss of it rather than a path that never produced anything.
      queueState.lens.set(DLQ_NOTIFICATION_SEND, 4)
      const during = await get()
      expect(during.body.dlq).toEqual({ "notification.send": 4 })
      expect(during.body.status).toBe("degraded")

      // FAILURE ARM — every queue read throws.
      queueState.lens.clear()
      queueState.lLenError = new Error("READONLY You can't write against a read only replica")
      const after = await get()

      expect(after.statusCode).toBe(200)
      expect(after.body.status).toBe("healthy")
      expect(after.body).not.toHaveProperty("dlq")
      expect(after.body).not.toHaveProperty("outbox")
      // The failure was contained to checkQueues: the redis CHECK (a separate
      // `ping`) is untouched, so this is the swallowing catch doing its job and
      // not a Redis outage that would have been reported as unhealthy anyway.
      expect((after.body.checks as Record<string, string>).redis).toBe("ok")
    })
  })
})
