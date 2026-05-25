// postgres-audit-writer — P0-14 ON CONFLICT alignment.
//
// The audit-postgres schema (migration 001) has:
//   - PRIMARY KEY (id, recorded_at)         // id is BIGSERIAL
//   - INDEX (intent_hash, recorded_at DESC) // NOT UNIQUE
// There is NO unique constraint on (intent_hash, recorded_at). The
// previous SQL `ON CONFLICT (intent_hash, recorded_at) DO NOTHING`
// would throw Postgres 42P10 on the first INSERT once
// IBX_AUDIT_POSTGRES_ENABLED=true. This test pins the bare
// `ON CONFLICT DO NOTHING` so the SQL stays compatible with the
// current schema while remaining forward-compatible if a unique
// constraint is added upstream.
//
// The test stubs `$executeRawUnsafe` and asserts exactly what SQL the
// writer emits — no live database required.

import { describe, it, expect, vi } from "vitest"
import type { IntentAuditRow } from "@adjudicate/audit-postgres"
import { createPostgresAuditWriter } from "../postgres-audit-writer.js"

function makeRow(): IntentAuditRow {
  return {
    intent_hash: "abc123",
    session_id: "sess_test",
    kind: "order.cancel",
    principal: "user",
    taint: "TRUSTED",
    decision_kind: "EXECUTE",
    refusal_kind: null,
    refusal_code: null,
    decision_basis: ["business:RULE_SATISFIED"],
    resource_version: null,
    envelope_jsonb: "{}",
    decision_jsonb: "{}",
    recorded_at: new Date("2026-05-23T00:00:00.000Z"),
    duration_ms: 1,
    partition_month: "2026_05",
    record_version: 1,
    plan_jsonb: null,
    nonce: "n_test",
    supersedes_jsonb: null,
  } as unknown as IntentAuditRow
}

describe("postgres-audit-writer — P0-14 SQL shape", () => {
  it("emits bare ON CONFLICT DO NOTHING (no column list)", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const prisma = {
      $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args })
        return 1
      }),
    }
    const writer = createPostgresAuditWriter({ prisma })

    await writer.insertAudit(makeRow())

    expect(calls).toHaveLength(1)
    const sql = calls[0]!.sql
    // The SQL ends with `ON CONFLICT DO NOTHING` — no `(intent_hash, ...)`
    // column list (that constraint does not exist in the audit-postgres
    // schema; the previous SQL would throw 42P10).
    expect(sql).toMatch(/ON CONFLICT DO NOTHING\s*$/)
    // Explicitly guard against the broken form.
    expect(sql).not.toMatch(/ON CONFLICT\s*\(/)
  })

  it("forwards every column in column-order to $executeRawUnsafe", async () => {
    const prisma = {
      $executeRawUnsafe: vi.fn(async () => 1),
    }
    const writer = createPostgresAuditWriter({ prisma })
    const row = makeRow()
    await writer.insertAudit(row)

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1)
    const args = prisma.$executeRawUnsafe.mock.calls[0]!.slice(1)
    // Order matches the SQL — 19 columns total (v4 schema).
    expect(args).toHaveLength(19)
    expect(args[0]).toBe(row.intent_hash)
    expect(args[1]).toBe(row.session_id)
    expect(args[2]).toBe(row.kind)
  })

  it("invokes onInsert hook on success", async () => {
    const prisma = { $executeRawUnsafe: vi.fn(async () => 1) }
    const onInsert = vi.fn()
    const writer = createPostgresAuditWriter({ prisma, onInsert })
    const row = makeRow()
    await writer.insertAudit(row)
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(onInsert).toHaveBeenCalledWith(row)
  })

  // ── audit-2026-05-24 P1-4: onConflictNoOp dedup hook ──────────────────

  it("[P1-4] fires onConflictNoOp when $executeRawUnsafe returns 0 (ON CONFLICT absorbed)", async () => {
    // When the upstream UNIQUE constraint lands and a duplicate row is
    // attempted, `ON CONFLICT DO NOTHING` returns affected_rows=0. The
    // writer surfaces this via the dedup hook so apps/api can bump the
    // `kernel_audit_dedup_total` Prometheus counter.
    const prisma = { $executeRawUnsafe: vi.fn(async () => 0) }
    const onConflictNoOp = vi.fn()
    const writer = createPostgresAuditWriter({ prisma, onConflictNoOp })
    const row = makeRow()

    await writer.insertAudit(row)

    expect(onConflictNoOp).toHaveBeenCalledTimes(1)
    expect(onConflictNoOp).toHaveBeenCalledWith(row)
  })

  it("[P1-4] does NOT fire onConflictNoOp when $executeRawUnsafe returns 1 (fresh insert)", async () => {
    const prisma = { $executeRawUnsafe: vi.fn(async () => 1) }
    const onConflictNoOp = vi.fn()
    const writer = createPostgresAuditWriter({ prisma, onConflictNoOp })
    await writer.insertAudit(makeRow())
    expect(onConflictNoOp).not.toHaveBeenCalled()
  })

  it("[P1-4] swallows errors thrown by onConflictNoOp — telemetry never blocks INSERT", async () => {
    const prisma = { $executeRawUnsafe: vi.fn(async () => 0) }
    const onConflictNoOp = vi.fn(() => {
      throw new Error("metric registry exploded")
    })
    const writer = createPostgresAuditWriter({ prisma, onConflictNoOp })

    // Even though the hook throws, insertAudit MUST resolve cleanly. A
    // metric-registry failure cannot kill the audit pipeline.
    await expect(writer.insertAudit(makeRow())).resolves.toBeUndefined()
    expect(onConflictNoOp).toHaveBeenCalledOnce()
  })
})
