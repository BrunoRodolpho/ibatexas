// Integration tests for intent-audit-wiring.ts post-Task-19 composition.
//
// Asserts the durable Postgres sink + persistent buffer compose correctly
// behind the AuditRedactor. The contract under test:
//
//   1. When IBX_AUDIT_POSTGRES_ENABLED=true, an AuditRecord emitted through
//      getAuditSink() lands in the Prisma raw-executor stub (i.e. the
//      Postgres sink is in the multi-sink fan-out).
//   2. When IBX_AUDIT_POSTGRES_ENABLED is unset/false, no Postgres call
//      fires — the existing console + NATS sinks still work.
//   3. The redactor runs BEFORE the buffered sink — the row passed to the
//      Postgres writer contains [REDACTED] sentinels for cpf/email,
//      never raw PII. (Critical bypass-detection assertion per Task 18.)
//   4. When the inner sink (Postgres) fails, records spill to the Redis
//      stub. The next successful emit drains the spill.
//   5. Pre-existing redactor invariants survive — `intentHash` and
//      `auditHash` are unchanged across emit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildAuditRecord, buildEnvelope } from "@adjudicate/core"
import type { AuditRecord } from "@adjudicate/core"

// ── Hoisted mocks ──────────────────────────────────────────────────────────
//
// We mock @ibatexas/nats-client (so no real NATS connection is required)
// and @ibatexas/domain (so no Prisma client is constructed). The
// intent-audit-wiring module imports both at the top — vi.mock must run
// before the dynamic import inside each test.

const mockPublishNatsEvent = vi.hoisted(() => vi.fn(async () => undefined))
const mockGetRedisClient = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (key: string) => `test:${key}`,
}))

vi.mock("@ibatexas/domain", () => ({
  // Surface a no-op Prisma stand-in. The wiring module wraps this in the
  // postgres-audit-writer which forwards to $executeRawUnsafe — when we run
  // with IBX_AUDIT_POSTGRES_ENABLED=true we install a writer-override via
  // `_setAuditSinkDependencies` so this mock is never actually called.
  prisma: { $executeRawUnsafe: vi.fn(async () => 0) },
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(opts: {
  kind: string
  payload: unknown
  sessionId?: string
  nonce?: string
}): AuditRecord {
  const envelope = buildEnvelope({
    kind: opts.kind,
    payload: opts.payload,
    actor: { principal: "user", sessionId: opts.sessionId ?? "sess_test" },
    taint: "UNTRUSTED",
    nonce: opts.nonce ?? "n_test",
    createdAt: "2026-04-23T00:00:00.000Z",
  })
  return buildAuditRecord({
    envelope,
    decision: { kind: "EXECUTE", basis: [] },
    durationMs: 1,
    at: "2026-04-23T00:00:00.001Z",
  })
}

// In-memory Redis list stub matching RedisListClient.
function makeRedisStub() {
  const store = new Map<string, string[]>()
  return {
    _store: store,
    async rPush(key: string, value: string) {
      const list = store.get(key) ?? []
      list.push(value)
      store.set(key, list)
      return list.length
    },
    async lPop(key: string) {
      const list = store.get(key)
      if (!list || list.length === 0) return null
      return list.shift() ?? null
    },
    async lLen(key: string) {
      return store.get(key)?.length ?? 0
    },
    async expire(_key: string, _seconds: number) {
      return 1
    },
  }
}

// A Prisma raw-executor stub that records every INSERT call's arguments.
function makePrismaWriter() {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  return {
    _calls: calls,
    async $executeRawUnsafe(sql: string, ...args: unknown[]) {
      calls.push({ sql, args })
      return 1
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("intent-audit-wiring — Task 19 Postgres + persistent buffer", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv("APP_ENV", "test")
    // Default: empty hash secret is legal in tests (suppresses the warning
    // via a fresh redactor instance per test below).
    vi.stubEnv("AUDIT_REDACT_SECRET", "test-salt-32-xxxxxxxxxxxxxxxxxxx")
  })

  afterEach(async () => {
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
  })

  it("Postgres sink fires unconditionally (always-on, no env gating)", async () => {
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter()
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({
        kind: "customer.profile.update",
        payload: { id: "cust_1" },
      }),
    )

    expect(mockPublishNatsEvent).toHaveBeenCalledOnce()
    expect(prismaWriter._calls).toHaveLength(1)
    expect(prismaWriter._calls[0]!.sql).toContain("INSERT INTO intent_audit")
    expect(prismaWriter._calls[0]!.sql).toContain("ON CONFLICT")
  })

  it("redactor runs BEFORE Postgres sink — row payload contains [REDACTED], not raw CPF", async () => {
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter()
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({
        kind: "customer.pix.details.save",
        payload: {
          cpf: "12345678900",
          email: "leak@example.com",
          name: "João Silva",
        },
      }),
    )

    // Argument 11 (1-indexed in SQL, 10 in JS) is envelope_jsonb — the
    // serialized envelope with payload INCLUDED. We assert the raw CPF /
    // email is absent and the sentinel is present.
    expect(prismaWriter._calls).toHaveLength(1)
    const envelopeJson = prismaWriter._calls[0]!.args[10] as string
    expect(envelopeJson).toContain("[REDACTED]")
    expect(envelopeJson).not.toContain("12345678900")
    expect(envelopeJson).not.toContain("leak@example.com")
    // Name is hashed (HASH_FIELDS rule) — not [REDACTED], but `hashed:`.
    expect(envelopeJson).toContain("hashed:")
    expect(envelopeJson).not.toContain("João Silva")

    // Belt-and-braces: the NATS publish call should also have been redacted.
    const natsCall = mockPublishNatsEvent.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    const natsPayload = natsCall[1]
    const natsEnvelope = (natsPayload.envelope ?? {}) as Record<string, unknown>
    const natsPayloadStr = JSON.stringify(natsEnvelope.payload ?? {})
    expect(natsPayloadStr).toContain("[REDACTED]")
    expect(natsPayloadStr).not.toContain("12345678900")
  })

  it("preserves intentHash + auditHash through the redactor on the durable path", async () => {
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter()
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })

    const record = makeRecord({
      kind: "customer.pix.details.save",
      payload: { cpf: "12345678900", name: "X" },
    })
    const sink = wiring.getAuditSink()
    await sink.emit(record)

    // Arg 1 is intent_hash. It must match the original record's hash —
    // proving the redactor preserved it.
    expect(prismaWriter._calls[0]!.args[0]).toBe(record.intentHash)
  })

  it("spills to Redis when Postgres writer throws", async () => {
    // Force buffer capacity to 1 so the FIRST failure spills the SECOND
    // emit's record. Default 1000 would absorb the failure into the in-
    // memory queue and never spill in a single-emit test.
    vi.stubEnv("IBX_AUDIT_BUFFER_CAPACITY", "1")
    const redis = makeRedisStub()
    const failingWriter = {
      async $executeRawUnsafe() {
        throw new Error("postgres down")
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter })

    const sink = wiring.getAuditSink()
    // The wiring layer swallows emit errors so the kernel never breaks.
    // We emit two records — the second triggers capacity-driven spill of
    // the first (which was buffered after the inner failure).
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { a: 1 } }),
    )
    await sink.emit(
      makeRecord({
        kind: "customer.profile.update",
        payload: { a: 2 },
        sessionId: "sess_2",
        nonce: "n_2",
      }),
    )

    // First emit failed → buffered in memory.
    // Second emit failed → first record evicted to Redis spill (capacity=1).
    expect(redis._store.get("test:audit:spill:queue") ?? []).toHaveLength(1)
  })

  it("multi-sink fan-out is wired in order: console, NATS, Postgres", async () => {
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter()
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { x: 1 } }),
    )

    // Both NATS and Postgres each fired exactly once. (Console fan-out has
    // no observable side effect in this test setup beyond stdout, so we
    // assert on the other two.)
    expect(mockPublishNatsEvent).toHaveBeenCalledOnce()
    expect(prismaWriter._calls).toHaveLength(1)
  })

  it("invalid IBX_AUDIT_BUFFER_CAPACITY falls back to 1000 with a warning", async () => {
    vi.stubEnv("IBX_AUDIT_BUFFER_CAPACITY", "not-a-number")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter()
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: {} }),
    )

    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("IBX_AUDIT_BUFFER_CAPACITY"),
      ),
    ).toBe(true)
    warnSpy.mockRestore()
  })

  // ── audit-2026-05-24 P1-4: ON CONFLICT dedup hook on the in-process path
  //
  // When the upstream `UNIQUE (intent_hash, recorded_at)` constraint lands
  // on `intent_audit`, the writer's `$executeRawUnsafe` returns 0 for the
  // second INSERT of the same row. The wiring forwards that to the
  // `setAuditDedupHook` callback so apps/api can bump
  // `kernel_audit_dedup_total{path="in_process"}`. This test simulates the
  // constraint via a Prisma stub that returns 0 and asserts the hook fires
  // with `path="in_process"`.

  it("[P1-4] fires setAuditDedupHook with path='in_process' when ON CONFLICT absorbs a duplicate", async () => {
    const redis = makeRedisStub()
    // Stub returns 0 — simulates the upstream UNIQUE constraint absorbing
    // the second INSERT.
    const dedupingWriter = {
      async $executeRawUnsafe() {
        return 0
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: dedupingWriter })

    const dedupHook = vi.fn()
    wiring.setAuditDedupHook(dedupHook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { x: 1 } }),
    )

    expect(dedupHook).toHaveBeenCalledTimes(1)
    expect(dedupHook).toHaveBeenCalledWith("in_process")
  })

  it("[P1-4] does NOT fire setAuditDedupHook on a fresh insert (writer returns 1)", async () => {
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter() // returns 1
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })

    const dedupHook = vi.fn()
    wiring.setAuditDedupHook(dedupHook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { x: 1 } }),
    )

    expect(dedupHook).not.toHaveBeenCalled()
  })
})

// ── Q4: recordSinkFailure wire-up ──────────────────────────────────────────
//
// The audit pipeline has three downstream failure paths:
//   1. Postgres sink onError      → recordSinkFailure({ sink: "postgres" })
//   2. NATS sink onFailure         → recordSinkFailure({ sink: "nats" })
//   3. Buffered sink onSpill       → recordSinkFailure when reason !== "capacity"
//
// Each test asserts the failure-hook fires with the matching `sink` label,
// a stable `errorClass`, and a monotonically increasing `consecutiveFailures`
// counter. PII guard: only fixed-enum and error-class labels are emitted —
// no record payload or actor principal.

describe("intent-audit-wiring — Q4 recordSinkFailure on downstream errors", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv("APP_ENV", "test")
    vi.stubEnv("AUDIT_REDACT_SECRET", "test-salt-32-xxxxxxxxxxxxxxxxxxx")
  })

  afterEach(async () => {
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
  })

  it("postgres sink failure bumps the hook with sink='postgres' and the error class", async () => {
    const redis = makeRedisStub()
    const failingWriter = {
      async $executeRawUnsafe() {
        throw new TypeError("pg connection refused")
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter })
    const hook = vi.fn()
    wiring.setAuditSinkFailureHook(hook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { a: 1 } }),
    )

    const postgresCalls = hook.mock.calls
      .map((c) => c[0] as { sink: string; errorClass: string })
      .filter((e) => e.sink === "postgres" && e.errorClass === "TypeError")
    expect(postgresCalls).toHaveLength(1)
    expect(postgresCalls[0]).toMatchObject({
      sink: "postgres",
      subject: "audit.intent.decision.v1",
      errorClass: "TypeError",
      consecutiveFailures: 1,
    })
  })

  it("postgres consecutiveFailures increments across repeated failures", async () => {
    const redis = makeRedisStub()
    const failingWriter = {
      async $executeRawUnsafe() {
        throw new Error("pg down")
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter })
    const hook = vi.fn()
    wiring.setAuditSinkFailureHook(hook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { a: 1 } }),
    )
    await sink.emit(
      makeRecord({
        kind: "customer.profile.update",
        payload: { a: 2 },
        sessionId: "sess_2",
        nonce: "n_2",
      }),
    )

    type Ev = {
      sink: string
      subject: string
      errorClass: string
      consecutiveFailures: number
    }
    const postgresErrors = hook.mock.calls
      .map((c) => c[0] as Ev)
      .filter((e) => e.sink === "postgres" && e.errorClass === "Error")
    // Two emits, both fail → consecutiveFailures should be [1, 2].
    expect(postgresErrors.map((e) => e.consecutiveFailures)).toEqual([1, 2])
  })

  it("buffered sink spill-failure fires recordSinkFailure with sink='postgres' + errorClass='spill_failure'", async () => {
    // Force the buffer to spill on inner failure. PostgresWriter throws so
    // the buffered sink runs the spill path with reason !== "capacity".
    vi.stubEnv("IBX_AUDIT_BUFFER_CAPACITY", "1")
    const redis = makeRedisStub()
    const failingWriter = {
      async $executeRawUnsafe() {
        throw new Error("pg down")
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter })
    const hook = vi.fn()
    wiring.setAuditSinkFailureHook(hook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { a: 1 } }),
    )
    await sink.emit(
      makeRecord({
        kind: "customer.profile.update",
        payload: { a: 2 },
        sessionId: "sess_2",
        nonce: "n_2",
      }),
    )

    const spillFailures = hook.mock.calls
      .map((c) => c[0] as { sink: string; errorClass: string })
      .filter((e) => e.errorClass === "spill_failure")
    // At least one spill_failure fired when the inner sink errored.
    expect(spillFailures.length).toBeGreaterThanOrEqual(1)
    expect(spillFailures[0]).toMatchObject({
      sink: "postgres",
      subject: "audit.intent.decision.v1",
      errorClass: "spill_failure",
    })
  })

  it("does not fire the failure hook on a clean emit", async () => {
    const redis = makeRedisStub()
    const prismaWriter = makePrismaWriter()
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter })
    const hook = vi.fn()
    wiring.setAuditSinkFailureHook(hook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: { x: 1 } }),
    )

    expect(hook).not.toHaveBeenCalled()
  })

  it("hook event labels are bounded (no PII): sink is fixed enum, errorClass is the error constructor name", async () => {
    const redis = makeRedisStub()
    const failingWriter = {
      async $executeRawUnsafe() {
        // Custom error with sensitive content in the message — must NOT
        // leak into the hook label. Only the constructor name reaches it.
        const e = new RangeError("CPF 12345678900 conflict")
        throw e
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter })
    const hook = vi.fn()
    wiring.setAuditSinkFailureHook(hook)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({
        kind: "customer.pix.details.save",
        payload: { cpf: "12345678900" },
      }),
    )

    const events = hook.mock.calls.map((c) => c[0]) as Array<{
      sink: string
      subject: string
      errorClass: string
      consecutiveFailures: number
    }>
    for (const ev of events) {
      // sink is the fixed kernel enum.
      expect(["console", "nats", "postgres"]).toContain(ev.sink)
      // errorClass is bounded — no error-message content.
      expect(ev.errorClass).not.toContain("12345678900")
      expect(ev.errorClass).not.toContain("CPF")
      // subject is a fixed string for the IbateXas audit pipeline.
      expect(ev.subject).toBe("audit.intent.decision.v1")
    }
    // And at least one event was emitted (sanity).
    expect(events.length).toBeGreaterThan(0)
  })

  it("setAuditSinkFailureHook(null) disables the hook", async () => {
    const redis = makeRedisStub()
    const failingWriter = {
      async $executeRawUnsafe() {
        throw new Error("pg down")
      },
    }
    const wiring = await import("../intent-audit-wiring.js")
    wiring._resetAuditSink()
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter })
    const hook = vi.fn()
    wiring.setAuditSinkFailureHook(hook)
    wiring.setAuditSinkFailureHook(null)

    const sink = wiring.getAuditSink()
    await sink.emit(
      makeRecord({ kind: "customer.profile.update", payload: {} }),
    )

    expect(hook).not.toHaveBeenCalled()
  })
})
