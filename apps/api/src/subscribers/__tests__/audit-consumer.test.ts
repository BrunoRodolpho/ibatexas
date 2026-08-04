// Unit tests for the audit-consumer NATS subscriber — task 19 (M4).
//
// Asserts the redundancy-archiver behaviour (always-on per IBX-IGE v3.0
// cutover — no env-var gate):
//   1. Subscribes to "audit.intent.decision.v1" unconditionally.
//   2. New record → Postgres INSERT fires + dedup ledger key set.
//   3. Duplicate via isNewEvent → no Postgres call.
//   4. Duplicate via Postgres unique constraint (writer throws nothing
//      because the SQL uses ON CONFLICT DO NOTHING in the real adapter —
//      we simulate by making the writer succeed silently for the dup
//      case).
//   5. Malformed payload → DLQ + no INSERT.
//   6. Postgres connection error → DLQ + no infinite retry.
//
// External dependencies mocked at the module boundary:
//   - @ibatexas/nats-client (subscribe)
//   - @ibatexas/tools (getRedisClient → the canonical in-memory adapter; `rk`
//     is the REAL one)
//   - @ibatexas/domain (prisma → no-op)
//   - @ibatexas/llm-provider (createPostgresAuditWriter → injected stub)
//   - @sentry/node (DLQ telemetry)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createInMemoryRedis } from "@ibatexas/tools/testing"
import { rk } from "@ibatexas/tools"
import { buildEnvelope, buildAuditRecord } from "@adjudicate/core"
import type { AuditRecord } from "@adjudicate/core"
import type {
  IntentAuditRow,
  PostgresWriter,
} from "@adjudicate/audit-postgres"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockSentryWithScope = vi.hoisted(() => vi.fn())
const mockSentryCaptureMessage = vi.hoisted(() => vi.fn())

let redis: ReturnType<typeof createInMemoryRedis>

// R5-S8 — the canonical in-memory adapter replaces a hand-rolled stub whose
// `lPush` was a fiction: it APPENDED to a newline-joined STRING under the DLQ
// key. Production writes those keys as real Redis lists (`dlq.ts:29` LPUSH), so
// the DLQ assertions below were satisfied by a string the stub invented, and a
// WRONGTYPE — writing a string where production writes a list — could never
// surface. The adapter models the list kind, so `pushToDlq` now writes what it
// writes in production.
//
// The delegate (rather than handing `redis.client` over directly) exists for
// ONE reason: the dedup-failure case swaps in a `set` that throws, via an object
// spread. Delegating keeps that override byte-identical while every command
// still runs the adapter's real semantics. It carries exactly the four commands
// the consumer's path reaches (`dedup.ts` set, `dlq.ts` lPush/expire, plus get);
// do not widen it into a general spy hole.
function makeRedisStub() {
  return {
    async get(key: string) {
      return redis.client.get(key)
    },
    async set(
      key: string,
      value: string,
      opts?: { NX?: boolean; EX?: number },
    ): Promise<string | null> {
      return redis.client.set(key, value, opts as never)
    },
    async lPush(key: string, value: string) {
      return redis.client.lPush(key, value)
    },
    async expire(key: string, seconds: number) {
      return redis.client.expire(key, seconds)
    },
  }
}

let redisStub: ReturnType<typeof makeRedisStub>

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
}))

vi.mock("@ibatexas/tools", async () => {
  // `rk` was faked as `test:${key}`. That prefix happened to AGREE with the real
  // one (the suite stubs APP_ENV=test below), so this was never a wrong-prefix
  // fiction — but it made the agreement a coincidence rather than a fact. It is
  // spread from the real module now, so the keys the consumer writes and the
  // keys asserted below cannot drift apart.
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools")
  return { ...actual, getRedisClient: vi.fn(async () => redisStub) }
})

vi.mock("@ibatexas/domain", () => ({
  prisma: { $executeRawUnsafe: vi.fn(async () => 0) },
}))

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope,
  captureMessage: mockSentryCaptureMessage,
  init: vi.fn(),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

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

function makeRecord(kind = "customer.profile.update"): AuditRecord {
  const env = buildEnvelope({
    kind,
    payload: { id: "cust_test" },
    actor: { principal: "user", sessionId: "sess_test" },
    taint: "TRUSTED",
    nonce: "n_test",
    createdAt: "2026-04-23T00:00:00.000Z",
  })
  return buildAuditRecord({
    envelope: env,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
    at: "2026-04-23T00:00:00.001Z",
  })
}

async function getRegisteredCallback(
  startFn: (
    log?: import("fastify").FastifyBaseLogger,
  ) => Promise<void>,
  log?: import("fastify").FastifyBaseLogger,
): Promise<(payload: unknown) => Promise<void>> {
  mockSubscribeNatsEvent.mockClear()
  // subscribe returns { unsubscribe } in production; the stub must too.
  mockSubscribeNatsEvent.mockResolvedValue({ unsubscribe: () => undefined })
  await startFn(log)
  expect(mockSubscribeNatsEvent).toHaveBeenCalledOnce()
  const call = mockSubscribeNatsEvent.mock.calls[0] as unknown as [
    string,
    (payload: unknown) => Promise<void>,
  ]
  expect(call[0]).toBe("audit.intent.decision.v1")
  return call[1]
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("audit-consumer subscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv("APP_ENV", "test")
    redis = createInMemoryRedis()
    redisStub = makeRedisStub()
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setLevel: vi.fn() }),
    )
  })

  // ── 1. Always-on subscription ───────────────────────────────────────────

  it("subscribes to 'audit.intent.decision.v1' unconditionally (no env gate)", async () => {
    const writer: PostgresWriter = { insertAudit: vi.fn(async () => undefined) }
    const { startAuditConsumer, _setAuditConsumerWriter } = await import(
      "../audit-consumer.js"
    )
    _setAuditConsumerWriter(writer)
    await getRegisteredCallback(startAuditConsumer, makeLogger())
    _setAuditConsumerWriter(null)
  })

  // ── 2. New record → INSERT + dedup ledger set ──────────────────────────

  it("writes new record to Postgres + sets dedup key", async () => {
    const insertAudit = vi.fn(async (_row: IntentAuditRow) => undefined)
    const writer: PostgresWriter = { insertAudit }
    const { startAuditConsumer, _setAuditConsumerWriter } = await import(
      "../audit-consumer.js"
    )
    _setAuditConsumerWriter(writer)

    const callback = await getRegisteredCallback(
      startAuditConsumer,
      makeLogger(),
    )

    const record = makeRecord()
    await callback(record as unknown as Record<string, unknown>)

    expect(insertAudit).toHaveBeenCalledOnce()
    const row = insertAudit.mock.calls[0]![0] as IntentAuditRow
    expect(row.intent_hash).toBe(record.intentHash)
    expect(row.kind).toBe("customer.profile.update")

    // Dedup ledger key was set.
    const dedupKey = rk(
      `nats:processed:audit.intent.decision.v1:${record.intentHash}:${record.at}`,
    )
    expect(await redis.client.exists(dedupKey)).toBe(1)

    _setAuditConsumerWriter(null)
  })

  // ── 3. Dedup ledger blocks duplicate delivery ──────────────────────────

  it("skips when isNewEvent returns false (NATS redelivery)", async () => {
    const insertAudit = vi.fn(async () => undefined)
    const writer: PostgresWriter = { insertAudit }
    const { startAuditConsumer, _setAuditConsumerWriter } = await import(
      "../audit-consumer.js"
    )
    _setAuditConsumerWriter(writer)

    const callback = await getRegisteredCallback(startAuditConsumer)

    const record = makeRecord()
    // First delivery — writes.
    await callback(record as unknown as Record<string, unknown>)
    expect(insertAudit).toHaveBeenCalledTimes(1)

    // Second delivery with same intentHash + at — dedup ledger blocks.
    await callback(record as unknown as Record<string, unknown>)
    expect(insertAudit).toHaveBeenCalledTimes(1)

    _setAuditConsumerWriter(null)
  })

  // ── 4. Malformed payload → DLQ, no INSERT ──────────────────────────────

  it("DLQs malformed payload and does NOT call Postgres", async () => {
    const insertAudit = vi.fn(async () => undefined)
    const writer: PostgresWriter = { insertAudit }
    const { startAuditConsumer, _setAuditConsumerWriter } = await import(
      "../audit-consumer.js"
    )
    _setAuditConsumerWriter(writer)

    const callback = await getRegisteredCallback(
      startAuditConsumer,
      makeLogger(),
    )

    // Missing intentHash + at + envelope.
    await callback({ junk: true } as Record<string, unknown>)

    expect(insertAudit).not.toHaveBeenCalled()
    // DLQ list got an entry.
    const dlqKeys = redis.keys().filter((k) => k.includes("dlq:"))
    expect(dlqKeys.length).toBeGreaterThanOrEqual(1)

    _setAuditConsumerWriter(null)
  })

  // ── 5. Postgres error → DLQ ────────────────────────────────────────────

  it("pushes to DLQ when Postgres writer throws", async () => {
    const insertAudit = vi.fn(async () => {
      throw new Error("postgres down")
    })
    const writer: PostgresWriter = { insertAudit }
    const { startAuditConsumer, _setAuditConsumerWriter } = await import(
      "../audit-consumer.js"
    )
    _setAuditConsumerWriter(writer)

    const callback = await getRegisteredCallback(
      startAuditConsumer,
      makeLogger(),
    )

    const record = makeRecord()
    await callback(record as unknown as Record<string, unknown>)

    // Writer was attempted, threw, then DLQ.
    expect(insertAudit).toHaveBeenCalledOnce()
    const dlqKeys = redis.keys().filter((k) => k.includes("dlq:"))
    expect(dlqKeys.length).toBeGreaterThanOrEqual(1)

    _setAuditConsumerWriter(null)
  })

  // ── 6. Dedup-ledger failure is non-fatal ───────────────────────────────

  it("proceeds to INSERT when dedup ledger check fails", async () => {
    // Replace redisStub with one whose `set` always throws to simulate a
    // Redis hiccup. The consumer's dedup-failure branch must still call
    // the writer (ON CONFLICT is the second-layer safety net).
    redisStub = {
      ...makeRedisStub(),
      async set() {
        throw new Error("redis down")
      },
    }
    const insertAudit = vi.fn(async () => undefined)
    const writer: PostgresWriter = { insertAudit }
    const { startAuditConsumer, _setAuditConsumerWriter } = await import(
      "../audit-consumer.js"
    )
    _setAuditConsumerWriter(writer)

    const callback = await getRegisteredCallback(
      startAuditConsumer,
      makeLogger(),
    )

    const record = makeRecord()
    await callback(record as unknown as Record<string, unknown>)

    expect(insertAudit).toHaveBeenCalledOnce()
    _setAuditConsumerWriter(null)
  })

  // ── 7. [audit-2026-05-24 P1-4] consumer dedup hook is exposed ──────────
  //
  // The hook is wired by apps/api during `installKernelMetricsSink` and
  // bumps `kernel_audit_dedup_total{path="consumer"}` whenever the
  // writer's `ON CONFLICT DO NOTHING` absorbs a duplicate. Until the
  // upstream UNIQUE constraint lands in `@adjudicate/audit-postgres`,
  // this hook will not fire in production — every INSERT lands a fresh
  // row. The test asserts the setter is exported and idempotent so the
  // wiring is in place for the schema migration.

  it("[P1-4] setAuditConsumerDedupHook is exported and accepts both a function and null", async () => {
    const { setAuditConsumerDedupHook } = await import("../audit-consumer.js")
    expect(typeof setAuditConsumerDedupHook).toBe("function")

    // Should accept a function spy without throwing.
    const hook = vi.fn()
    expect(() => setAuditConsumerDedupHook(hook)).not.toThrow()

    // Should accept null (disable) without throwing.
    expect(() => setAuditConsumerDedupHook(null)).not.toThrow()
  })
})
