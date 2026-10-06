// OpsAlertService + ops-alert-policy — unit tests (no live DB).
//
// NEW-025 ops-alert plane (detection half). Covers:
//   - the frozen ops-cause governance guard (REFUSE off-taxonomy, EXECUTE valid),
//     plus the SYSTEM-only taint floor (an UNTRUSTED/LLM proposal is refused);
//   - the PURE `maxSeverity` monotonic-up derivation;
//   - the condition-dedup open path (fold-in an existing open alert / fresh
//     create / P2002 partial-unique race) against a stubbed prisma;
//   - the resolve contract (current-on-found / current-on-already-terminal /
//     null-on-missing — load-bearing for the admin 404), incl. AUTO vs STAFF.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import type { AuditSink } from "@adjudicate/core"
import { randomUUID } from "node:crypto"

const mockFindFirst = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockUpdateMany = vi.hoisted(() => vi.fn())
const mockFindUnique = vi.hoisted(() => vi.fn())
const mockCount = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    opsAlert: {
      findFirst: mockFindFirst,
      create: mockCreate,
      update: mockUpdate,
      updateMany: mockUpdateMany,
      findUnique: mockFindUnique,
      count: mockCount,
      findMany: mockFindMany,
    },
  },
}))

vi.mock("../../generated/prisma-client/client.js", () => ({
  Prisma: {
    JsonNull: { __jsonNull: true },
    PrismaClientKnownRequestError: class extends Error {
      code: string
      meta?: Record<string, unknown>
      clientVersion: string
      constructor(
        message: string,
        opts: { code: string; clientVersion: string; meta?: Record<string, unknown> },
      ) {
        super(message)
        this.code = opts.code
        this.clientVersion = opts.clientVersion
        this.meta = opts.meta
      }
    },
  },
}))

import { createOpsAlertService, maxSeverity } from "../ops-alert.service.js"
import { Prisma } from "../../generated/prisma-client/client.js"
import type {
  OpsAlertOpenPayload,
  OpsAlertResolvePayload,
  OpsAlertState,
} from "../__shared__/ops-alert-policy.js"

const state: OpsAlertState = { ctx: {} }
const SEEN_AT = new Date("2026-07-03T12:00:00.000Z")

// Minimal OpsAlert-shaped row (only the fields the service reads/returns).
function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ops_01",
    cause: "ops_dlq_depth",
    severity: "medium",
    status: "OPEN",
    source: "dlq-depth-checker",
    scope: "audit-consumer",
    title: "DLQ acumulando",
    detail: null,
    context: null,
    occurrences: 1,
    dedupeKey: "ops_dlq_depth:audit-consumer",
    firstSeenAt: SEEN_AT,
    lastSeenAt: SEEN_AT,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionType: null,
    createdAt: SEEN_AT,
    updatedAt: SEEN_AT,
    ...over,
  } as never
}

function openPayload(over: Partial<OpsAlertOpenPayload> = {}): OpsAlertOpenPayload {
  return {
    cause: "ops_dlq_depth",
    severity: "medium",
    source: "dlq-depth-checker",
    scope: "audit-consumer",
    title: "DLQ acumulando",
    dedupeKey: "ops_dlq_depth:audit-consumer",
    ...over,
  }
}

const systemOpenEnv = (payload: OpsAlertOpenPayload) =>
  buildEnvelope({
    kind: "ops.alert.open" as const,
    payload,
    actor: { principal: "system" as const, sessionId: "dlq-depth-checker:sweep_1" },
    taint: "SYSTEM" as const,
    nonce: randomUUID(),
  })

const untrustedOpenEnv = (payload: OpsAlertOpenPayload) =>
  buildEnvelope({
    kind: "ops.alert.open" as const,
    payload,
    actor: { principal: "llm" as const, sessionId: "wa:test" },
    taint: "UNTRUSTED" as const,
    nonce: randomUUID(),
  })

const systemResolveEnv = (payload: OpsAlertResolvePayload) =>
  buildEnvelope({
    kind: "ops.alert.resolve" as const,
    payload,
    actor: { principal: "system" as const, sessionId: "ops.resolve:sweep_2" },
    taint: "SYSTEM" as const,
    nonce: randomUUID(),
  })

describe("ops-alert-policy — frozen-cause governance guard", () => {
  beforeEach(() => vi.clearAllMocks())

  it("EXECUTEs a valid in-taxonomy cause (executor runs, fresh alert created)", async () => {
    mockFindFirst.mockResolvedValue(null) // none open
    mockCreate.mockResolvedValue(makeRow())

    const svc = createOpsAlertService()
    const out = await svc.openAlertFromEnvelope(
      systemOpenEnv(openPayload({ cause: "ops_stuck_order" })),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result?.opened).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("REFUSEs an out-of-taxonomy cause (executor never runs)", async () => {
    const svc = createOpsAlertService()
    const out = await svc.openAlertFromEnvelope(
      systemOpenEnv(
        openPayload({ cause: "bogus_cause" as OpsAlertOpenPayload["cause"] }),
      ),
      state,
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(out.result).toBeUndefined()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it("REFUSEs an UNTRUSTED (LLM) proposal even with a valid cause (SYSTEM-only)", async () => {
    const svc = createOpsAlertService()
    const out = await svc.openAlertFromEnvelope(untrustedOpenEnv(openPayload()), state)

    expect(out.decision.kind).toBe("REFUSE")
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe("maxSeverity — pure monotonic-up", () => {
  it("returns the higher band", () => {
    expect(maxSeverity("low", "high")).toBe("high")
    expect(maxSeverity("high", "low")).toBe("high")
    expect(maxSeverity("medium", "low")).toBe("medium")
    expect(maxSeverity("low", "low")).toBe("low")
  })
})

describe("openAlertFromEnvelope — condition dedup + P2002 race", () => {
  beforeEach(() => vi.resetAllMocks())

  it("folds a repeat detection into an existing OPEN alert (occurrences++, no new row)", async () => {
    mockFindFirst.mockResolvedValueOnce(makeRow({ occurrences: 1 })) // existing open
    mockUpdate.mockResolvedValue(makeRow({ occurrences: 2 }))

    const svc = createOpsAlertService()
    const out = await svc.openAlertFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(false)
    expect((out.result?.alert as { occurrences: number }).occurrences).toBe(2)
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ occurrences: { increment: 1 } }),
      }),
    )
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("escalates severity monotonically on fold-in (open=low + incoming=high → high)", async () => {
    mockFindFirst.mockResolvedValueOnce(makeRow({ severity: "low" }))
    mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      makeRow({ ...data }),
    )

    const svc = createOpsAlertService()
    await svc.openAlertFromEnvelope(
      systemOpenEnv(openPayload({ severity: "high" })),
      state,
    )

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ severity: "high" }) }),
    )
  })

  it("creates a fresh alert when none is open for the condition", async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    mockCreate.mockResolvedValue(makeRow())

    const svc = createOpsAlertService()
    const out = await svc.openAlertFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: "ops_dlq_depth:audit-consumer",
          status: "OPEN",
          occurrences: 1,
        }),
      }),
    )
  })

  it("catches a dedupe-open P2002 → re-reads the racing open row + folds in", async () => {
    mockFindFirst
      .mockResolvedValueOnce(null) // (1) existing open: none
      .mockResolvedValueOnce(makeRow({ occurrences: 1 })) // (2) racing re-read after P2002
    mockCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "ops_alerts_dedupe_open_uq" },
      }),
    )
    mockUpdate.mockResolvedValue(makeRow({ occurrences: 2 }))

    const svc = createOpsAlertService()
    const out = await svc.openAlertFromEnvelope(systemOpenEnv(openPayload()), state)

    expect(out.result?.opened).toBe(false)
    expect((out.result?.alert as { occurrences: number }).occurrences).toBe(2)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})

describe("resolveAlertFromEnvelope — current-on-found / null-on-missing", () => {
  beforeEach(() => vi.resetAllMocks())

  it("STAFF resolution transitions to RESOLVED and returns the row", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(
      makeRow({ status: "RESOLVED", resolvedBy: "staff:1", resolutionType: "STAFF" }),
    )

    const svc = createOpsAlertService()
    const out = await svc.resolveAlertFromEnvelope(
      systemResolveEnv({ id: "ops_01", resolvedBy: "staff:1", resolutionType: "STAFF" }),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect((out.result as { status: string }).status).toBe("RESOLVED")
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RESOLVED" }) }),
    )
  })

  it("AUTO resolution (watchdog observed cleared) transitions to AUTO_RESOLVED", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "AUTO_RESOLVED" }))

    const svc = createOpsAlertService()
    await svc.resolveAlertFromEnvelope(
      systemResolveEnv({ id: "ops_01", resolvedBy: "system", resolutionType: "AUTO" }),
      state,
    )

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTO_RESOLVED" }),
      }),
    )
  })

  it("returns the current row (no error) when already terminal (count===0, idempotent)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "AUTO_RESOLVED" }))

    const svc = createOpsAlertService()
    const out = await svc.resolveAlertFromEnvelope(
      systemResolveEnv({ id: "ops_01", resolvedBy: "system", resolutionType: "AUTO" }),
      state,
    )

    expect((out.result as { status: string }).status).toBe("AUTO_RESOLVED")
  })

  it("returns null ONLY when the id does not exist", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(null)

    const svc = createOpsAlertService()
    const out = await svc.resolveAlertFromEnvelope(
      systemResolveEnv({ id: "missing", resolvedBy: "system", resolutionType: "AUTO" }),
      state,
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toBeNull()
  })
})

// BKL-260 (PR #423) shipped this method covered only INDIRECTLY, by the apps/api
// runtime class gate. These are its DIRECT unit tests. It is the raw post-decision
// persistence body — the ops registry's `ops.alert.resolve.staff` executor calls it
// holding a positive decision the composed ops router already produced. The contract
// below is FROZEN: these tests pin the shipped behavior, they do not change it.
describe("writeAdjudicatedAlertResolve — post-decision write body (BKL-260)", () => {
  beforeEach(() => vi.resetAllMocks())

  const staffPayload: OpsAlertResolvePayload = {
    id: "ops_01",
    resolvedBy: "staff:7",
    resolutionType: "STAFF",
  }

  it("STAFF resolve writes RESOLVED under the NON_TERMINAL filter and returns the re-read row", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(
      makeRow({ status: "RESOLVED", resolvedBy: "staff:7", resolutionType: "STAFF" }),
    )

    const svc = createOpsAlertService()
    const row = await svc.writeAdjudicatedAlertResolve(staffPayload)

    expect(row).toMatchObject({ id: "ops_01", status: "RESOLVED", resolvedBy: "staff:7" })
    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    const call = mockUpdateMany.mock.calls[0]![0]
    // Idempotent transition — only a non-terminal row moves.
    expect(call.where).toEqual({ id: "ops_01", status: { in: ["OPEN", "ACKNOWLEDGED"] } })
    expect(call.data).toMatchObject({
      status: "RESOLVED",
      resolvedBy: "staff:7",
      resolutionType: "STAFF",
    })
    expect(call.data.resolvedAt).toBeInstanceOf(Date)
    // The return is a RE-READ of the row, never the write patch merged onto a stale
    // read — which is why discarding updateMany's `{count}` is SOUND here (contrast
    // BKL-265's mutateOrNull, where the merged object WAS the return).
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: "ops_01" } })
  })

  it("AUTO resolve writes AUTO_RESOLVED — the terminal status is derived, never taken from the caller", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "AUTO_RESOLVED" }))

    const svc = createOpsAlertService()
    await svc.writeAdjudicatedAlertResolve({
      id: "ops_01",
      resolvedBy: "system",
      resolutionType: "AUTO",
    })

    expect(mockUpdateMany.mock.calls[0]![0].data).toMatchObject({
      status: "AUTO_RESOLVED",
      resolutionType: "AUTO",
    })
  })

  it("returns the CURRENT row when the alert is already terminal (count === 0 is a no-op, not an error)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "RESOLVED", resolvedBy: "staff:1" }))

    const svc = createOpsAlertService()
    const row = await svc.writeAdjudicatedAlertResolve(staffPayload)

    // Already-resolved must not error and must not be reported as absent: the row
    // exists, so the render gate is allowed to voice a resolved alert.
    expect(row).toMatchObject({ status: "RESOLVED", resolvedBy: "staff:1" })
  })

  it("returns null ONLY when the id does not exist — the signal the #412 render gate keys on", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    mockFindUnique.mockResolvedValue(null)

    const svc = createOpsAlertService()
    const row = await svc.writeAdjudicatedAlertResolve({ ...staffPayload, id: "missing" })

    expect(row).toBeNull()
  })

  it("performs NO adjudication — the audit sink is never touched", async () => {
    const sink = { emit: vi.fn().mockResolvedValue(undefined) }
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue(makeRow({ status: "RESOLVED" }))

    const svc = createOpsAlertService({ auditSink: sink as unknown as AuditSink })
    await svc.writeAdjudicatedAlertResolve(staffPayload)

    // The caller already holds the decision. A record emitted here would be the
    // SECOND intent_audit EXECUTE row for one staff action — exactly the BKL-232/242
    // duplicate this entry point was extracted to remove.
    expect(sink.emit).not.toHaveBeenCalled()

    // POSITIVE CONTROL — the same sink on the same service DOES emit through the
    // self-adjudicating sibling, so the assertion above is a real observation and
    // not a sink that could never have fired.
    await svc.resolveAlertFromEnvelope(systemResolveEnv(staffPayload), state)
    expect(sink.emit).toHaveBeenCalledTimes(1)
  })
})

describe("list — openCount NON_TERMINAL, independent of filters", () => {
  beforeEach(() => vi.resetAllMocks())

  it("openCount counts NON_TERMINAL (OPEN + ACKNOWLEDGED), not rows.length", async () => {
    mockFindMany.mockResolvedValue([makeRow({ id: "o1", status: "OPEN" })])
    mockCount.mockResolvedValue(5)

    const svc = createOpsAlertService()
    const out = await svc.list({ cause: "ops_dlq_depth" })

    expect(out.alerts).toHaveLength(1)
    expect(out.openCount).toBe(5)
    // The badge query uses the NON_TERMINAL { in: [...] } predicate.
    const countWhere = (mockCount.mock.calls[0]![0] as {
      where: { status: { in: string[] } }
    }).where
    expect(countWhere.status.in).toEqual(
      expect.arrayContaining(["OPEN", "ACKNOWLEDGED"]),
    )
    // The list where-clause carries the cause filter but the count does NOT.
    const listWhere = (mockFindMany.mock.calls[0]![0] as {
      where: Record<string, unknown>
    }).where
    expect(listWhere).toMatchObject({ cause: "ops_dlq_depth" })
  })
})
