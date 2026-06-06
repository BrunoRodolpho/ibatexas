// @ibatexas/audit-sink — leaf-package unit tests.
//
// Covers the boot-time DI contract (audit-2026-05-24 H2 §A1):
//   1. getAuditSink() throws AuditSinkNotInitializedError before
//      __setAuditSinkDependencies(...) is called.
//   2. After registration, getAuditSink() returns a usable AuditSink that
//      threads emit() through the redactor → buffered sink → fan-out.
//   3. The same sink is returned across calls (caching contract).
//   4. __resetAuditSink() / __setAuditSinkDependencies() swap deps cleanly
//      for test isolation.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  createInMemorySpillStorage,
  type PersistentSpillStorage,
} from "@adjudicate/audit"
import type { AuditRecord } from "@adjudicate/core"
import {
  __auditSinkInitialized,
  __resetAuditSink,
  __setAuditSinkDependencies,
  AuditSinkNotInitializedError,
  getAuditSink,
  type AuditSinkDependencies,
  type AuditSinkLogger,
  type AuditSinkPostgresWriter,
  type AuditSinkNatsPublisher,
  type AuditSinkRedactor,
} from "../index.js"

// ── Fixtures ─────────────────────────────────────────────────────────────

function fakeAuditRecord(overrides?: Partial<AuditRecord>): AuditRecord {
  return {
    at: new Date().toISOString(),
    auditHash: "audit-hash-fake",
    durationMs: 1,
    intentHash: "intent-hash-fake",
    decision: { kind: "EXECUTE", basis: [] },
    // `recordToRow` in @adjudicate/audit-postgres reads `record.decision_basis`
    // at top level (not on the Decision) so we surface an empty array here to
    // satisfy the postgres-sink path in tests.
    decision_basis: [],
    envelope: {
      kind: "order.cart.ensure",
      payload: { cartId: "cart_fake" },
      actor: { principal: "system", sessionId: "test:session" },
      taint: "SYSTEM",
      nonce: "nonce-fake",
      createdAt: new Date().toISOString(),
      version: 4,
      intentHash: "intent-hash-fake",
    },
    version: 4,
    ...overrides,
  } as unknown as AuditRecord
}

function makeStubDeps(
  overrides: Partial<AuditSinkDependencies> = {},
): {
  deps: AuditSinkDependencies
  spillStorage: PersistentSpillStorage
  postgresInserts: ReadonlyArray<unknown>[]
  natsPublishes: Array<{ subject: string; payload: Record<string, unknown> }>
  redactCalls: AuditRecord[]
  logger: AuditSinkLogger & {
    warns: Array<{ obj: unknown; msg: string | undefined }>
    errors: Array<{ obj: unknown; msg: string | undefined }>
  }
} {
  const postgresInserts: Array<readonly unknown[]> = []
  const natsPublishes: Array<{
    subject: string
    payload: Record<string, unknown>
  }> = []
  const redactCalls: AuditRecord[] = []
  const warns: Array<{ obj: unknown; msg: string | undefined }> = []
  const errors: Array<{ obj: unknown; msg: string | undefined }> = []

  const spillStorage = createInMemorySpillStorage()

  const postgresWriter: AuditSinkPostgresWriter = {
    async insertAudit(row) {
      postgresInserts.push(Object.values(row))
    },
  }

  const natsPublisher: AuditSinkNatsPublisher = {
    async publish(subject, payload) {
      natsPublishes.push({ subject, payload })
    },
  }

  const redactor: AuditSinkRedactor = {
    redact(record) {
      redactCalls.push(record)
      return record
    },
  }

  const logger: AuditSinkLogger & {
    warns: typeof warns
    errors: typeof errors
  } = {
    warns,
    errors,
    warn(obj, msg) {
      warns.push({ obj, msg })
    },
    error(obj, msg) {
      errors.push({ obj, msg })
    },
  }

  const deps: AuditSinkDependencies = {
    spillStorage,
    postgresWriter,
    natsPublisher,
    redactor,
    logger,
    ...overrides,
  }

  return {
    deps,
    spillStorage,
    postgresInserts,
    natsPublishes,
    redactCalls,
    logger,
  }
}

// ── Test isolation ────────────────────────────────────────────────────────

beforeEach(() => {
  __resetAuditSink()
})

afterEach(() => {
  __resetAuditSink()
})

// ── Boot-order guard ─────────────────────────────────────────────────────

describe("getAuditSink — boot-order guard", () => {
  it("throws AuditSinkNotInitializedError when called before registration", () => {
    expect(() => getAuditSink()).toThrow(AuditSinkNotInitializedError)
  })

  it("error message names the boot-wiring entrypoint so operators can self-diagnose", () => {
    try {
      getAuditSink()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(AuditSinkNotInitializedError)
      expect((err as Error).message).toMatch(/__setAuditSinkDependencies/)
      expect((err as Error).message).toMatch(/boot/)
    }
  })

  it("__auditSinkInitialized() returns false before registration", () => {
    expect(__auditSinkInitialized()).toBe(false)
  })

  it("__auditSinkInitialized() returns true after registration", () => {
    const { deps } = makeStubDeps()
    __setAuditSinkDependencies(deps)
    expect(__auditSinkInitialized()).toBe(true)
  })
})

// ── Happy path ───────────────────────────────────────────────────────────

describe("getAuditSink — wired dependencies", () => {
  it("returns a usable sink that redacts then fans out to NATS + Postgres + console", async () => {
    const { deps, postgresInserts, natsPublishes, redactCalls } =
      makeStubDeps()
    __setAuditSinkDependencies(deps)

    const sink = getAuditSink()
    const record = fakeAuditRecord()
    await sink.emit(record)

    // Redactor invoked exactly once with the original record.
    expect(redactCalls).toHaveLength(1)
    expect(redactCalls[0]!.envelope.kind).toBe("order.cart.ensure")

    // Postgres + NATS both received one emit.
    expect(postgresInserts).toHaveLength(1)
    expect(natsPublishes).toHaveLength(1)
    expect(natsPublishes[0]!.subject).toBe("audit.intent.decision.v1")
  })

  it("caches the sink across calls (same identity)", () => {
    const { deps } = makeStubDeps()
    __setAuditSinkDependencies(deps)
    const a = getAuditSink()
    const b = getAuditSink()
    expect(a).toBe(b)
  })

  it("rebuilds the sink after __setAuditSinkDependencies replaces deps", async () => {
    const first = makeStubDeps()
    __setAuditSinkDependencies(first.deps)
    const a = getAuditSink()

    const second = makeStubDeps()
    __setAuditSinkDependencies(second.deps)
    const b = getAuditSink()

    expect(a).not.toBe(b)

    await b.emit(fakeAuditRecord())
    expect(second.redactCalls).toHaveLength(1)
    expect(first.redactCalls).toHaveLength(0)
  })

  it("__resetAuditSink() returns the leaf to the not-initialized state", () => {
    const { deps } = makeStubDeps()
    __setAuditSinkDependencies(deps)
    expect(__auditSinkInitialized()).toBe(true)
    __resetAuditSink()
    expect(__auditSinkInitialized()).toBe(false)
    expect(() => getAuditSink()).toThrow(AuditSinkNotInitializedError)
  })
})

// ── Observability hooks ──────────────────────────────────────────────────

describe("getAuditSink — observability hooks", () => {
  it("fires onLag with sink='postgres' on successful emit", async () => {
    const lagEvents: Array<{ sink: string; latency: number }> = []
    const { deps } = makeStubDeps({
      onLag: (sink, latency) => {
        lagEvents.push({ sink, latency })
      },
    })
    __setAuditSinkDependencies(deps)

    const sink = getAuditSink()
    await sink.emit(fakeAuditRecord())

    expect(lagEvents).toHaveLength(1)
    expect(lagEvents[0]!.sink).toBe("postgres")
    expect(lagEvents[0]!.latency).toBeGreaterThanOrEqual(0)
  })

  it("fail-open on logger.warn: emit() does NOT throw when inner sink throws", async () => {
    // Postgres writer throws — the buffered sink catches & spills; the
    // leaf's outer emit() should NOT throw.
    const throwingDeps = makeStubDeps()
    const failingWriter: AuditSinkPostgresWriter = {
      async insertAudit() {
        throw new Error("postgres outage")
      },
    }
    __setAuditSinkDependencies({
      ...throwingDeps.deps,
      postgresWriter: failingWriter,
    })

    const sink = getAuditSink()
    // Should not throw — leaf is fail-open at the IbateXas boundary.
    await expect(sink.emit(fakeAuditRecord())).resolves.toBeUndefined()
  })

  it("invokes onSinkFailure hook fail-open if the hook itself throws", async () => {
    const onSinkFailure = vi.fn(() => {
      throw new Error("telemetry pipe broken")
    })
    const throwingPostgres: AuditSinkPostgresWriter = {
      async insertAudit() {
        throw new Error("postgres outage")
      },
    }
    const { deps } = makeStubDeps()
    __setAuditSinkDependencies({
      ...deps,
      postgresWriter: throwingPostgres,
      onSinkFailure,
    })

    const sink = getAuditSink()
    await expect(sink.emit(fakeAuditRecord())).resolves.toBeUndefined()
    expect(onSinkFailure).toHaveBeenCalled()
  })
})
