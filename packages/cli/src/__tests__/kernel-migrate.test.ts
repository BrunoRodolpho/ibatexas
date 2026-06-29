// Tests for lib/kernel-migrate.ts — the audit-postgres migration runner.
// Mocks the pg client; never connects to real Postgres. Reads the REAL
// @adjudicate/audit-postgres migration files via the workspace layout.
import { describe, it, expect, beforeEach, vi } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  AUDIT_MIGRATION_FILE_RE,
  MIGRATION_TRACKING_TABLE,
  listMigrationFiles,
  monthlyPartitionSpecs,
  partitionStatement,
  resolveAuditMigrationsDir,
  runAuditMigrations,
  type PgClientLike,
} from "../lib/kernel-migrate.js"

// Repo root from this test file: packages/cli/src/__tests__ → up 4.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../")
const MIGRATIONS_DIR = resolveAuditMigrationsDir(ROOT)

// ── Mock pg client ─────────────────────────────────────────────────────────

interface Call {
  text: string
  params?: ReadonlyArray<unknown>
}

function makeClient(appliedFilenames: string[] = []) {
  const calls: Call[] = []
  const query = vi.fn(
    async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params })
      if (text.includes(`SELECT filename FROM ${MIGRATION_TRACKING_TABLE}`)) {
        return {
          rows: appliedFilenames.map((f) => ({ filename: f })),
          rowCount: appliedFilenames.length,
        }
      }
      return { rows: [], rowCount: 0 }
    },
  )
  return { client: { query } as PgClientLike, calls, query }
}

const NOW = new Date(Date.UTC(2026, 5, 15)) // 2026-06-15

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("listMigrationFiles", () => {
  it("returns the audit migrations sorted, 001 before 008", () => {
    const files = listMigrationFiles(MIGRATIONS_DIR)
    expect(files.length).toBeGreaterThanOrEqual(8)
    expect(files.every((f) => AUDIT_MIGRATION_FILE_RE.test(f))).toBe(true)
    expect(files[0]).toMatch(/^001-/)
    expect([...files]).toEqual([...files].sort())
  })
})

describe("monthlyPartitionSpecs", () => {
  it("spans [now-back, now+forward] with UTC half-open bounds", () => {
    const specs = monthlyPartitionSpecs(NOW, 1, 3)
    expect(specs.map((s) => s.name)).toEqual([
      "intent_audit_2026_05",
      "intent_audit_2026_06",
      "intent_audit_2026_07",
      "intent_audit_2026_08",
      "intent_audit_2026_09",
    ])
    const june = specs.find((s) => s.name === "intent_audit_2026_06")!
    expect(june.from).toBe("2026-06-01 00:00:00+00")
    expect(june.to).toBe("2026-07-01 00:00:00+00")
  })

  it("rolls the year boundary correctly", () => {
    const dec = monthlyPartitionSpecs(new Date(Date.UTC(2026, 11, 2)), 0, 1)
    expect(dec.map((s) => s.name)).toEqual([
      "intent_audit_2026_12",
      "intent_audit_2027_01",
    ])
    expect(dec[0]!.to).toBe("2027-01-01 00:00:00+00")
  })
})

describe("partitionStatement", () => {
  it("emits CREATE TABLE IF NOT EXISTS … PARTITION OF intent_audit", () => {
    const sql = partitionStatement({
      name: "intent_audit_2026_06",
      from: "2026-06-01 00:00:00+00",
      to: "2026-07-01 00:00:00+00",
    })
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS intent_audit_2026_06")
    expect(sql).toContain("PARTITION OF intent_audit")
    expect(sql).toContain("FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')")
  })
})

describe("resolveAuditMigrationsDir", () => {
  it("locates the real audit-postgres migrations dir", () => {
    expect(MIGRATIONS_DIR).toContain("audit-postgres")
    expect(listMigrationFiles(MIGRATIONS_DIR).length).toBeGreaterThanOrEqual(8)
  })

  it("throws a helpful error when nothing resolves", () => {
    expect(() =>
      resolveAuditMigrationsDir("/nonexistent-root-xyz", "/also-missing"),
    ).toThrow(/Could not locate/)
  })
})

// ── runAuditMigrations ─────────────────────────────────────────────────────

describe("runAuditMigrations — fresh database", () => {
  let h: ReturnType<typeof makeClient>
  let result: Awaited<ReturnType<typeof runAuditMigrations>>

  beforeEach(async () => {
    vi.clearAllMocks()
    h = makeClient([]) // nothing applied yet
    result = await runAuditMigrations(h.client, {
      migrationsDir: MIGRATIONS_DIR,
      now: NOW,
    })
  })

  it("applies every migration exactly once, in order", () => {
    const files = listMigrationFiles(MIGRATIONS_DIR)
    expect(result.applied).toEqual(files)
    expect(result.skipped).toEqual([])
    // One tracking INSERT per file, params carry the filename in order.
    const inserts = h.calls.filter((c) =>
      c.text.includes(`INSERT INTO ${MIGRATION_TRACKING_TABLE}`),
    )
    expect(inserts.map((c) => c.params?.[0])).toEqual(files)
  })

  it("creates the tracking table before reading applied rows", () => {
    const createIdx = h.calls.findIndex((c) =>
      c.text.includes(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TRACKING_TABLE}`),
    )
    const selectIdx = h.calls.findIndex((c) =>
      c.text.includes(`SELECT filename FROM ${MIGRATION_TRACKING_TABLE}`),
    )
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(selectIdx).toBeGreaterThan(createIdx)
  })

  it("wraps each migration in BEGIN/COMMIT", () => {
    const begins = h.calls.filter((c) => c.text === "BEGIN").length
    const commits = h.calls.filter((c) => c.text === "COMMIT").length
    expect(begins).toBe(result.applied.length)
    expect(commits).toBe(result.applied.length)
  })

  it("ensures the monthly partitions after migrations", () => {
    expect(result.partitionsEnsured).toContain("intent_audit_2026_06")
    // Match the emitted partition DDL specifically — "PARTITION OF intent_audit
    // FOR VALUES" (single-spaced). 001's body mentions "PARTITION OF intent_audit"
    // in a comment, so a looser filter would miscount.
    const isPartitionDDL = (t: string) =>
      t.includes("PARTITION OF intent_audit FOR VALUES")
    const partCalls = h.calls.filter((c) => isPartitionDDL(c.text))
    expect(partCalls).toHaveLength(result.partitionsEnsured.length)
    // Partition creation comes after the last tracking insert (parent table first).
    const lastInsertIdx = h.calls.reduce(
      (acc, c, i) =>
        c.text.includes(`INSERT INTO ${MIGRATION_TRACKING_TABLE}`) ? i : acc,
      -1,
    )
    const firstPartIdx = h.calls.findIndex((c) => isPartitionDDL(c.text))
    expect(firstPartIdx).toBeGreaterThan(lastInsertIdx)
  })
})

describe("runAuditMigrations — idempotent re-run", () => {
  it("skips already-applied files and runs no BEGIN, but still ensures partitions", async () => {
    const files = listMigrationFiles(MIGRATIONS_DIR)
    const h = makeClient(files) // all already applied
    const result = await runAuditMigrations(h.client, {
      migrationsDir: MIGRATIONS_DIR,
      now: NOW,
    })
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual(files)
    expect(h.calls.some((c) => c.text === "BEGIN")).toBe(false)
    expect(h.calls.some((c) => c.text.includes("PARTITION OF intent_audit"))).toBe(true)
  })
})

describe("runAuditMigrations — failure handling", () => {
  it("rolls back and surfaces the file name when a migration throws", async () => {
    const h = makeClient([])
    // Fail on the first non-control SQL statement (the migration body).
    h.query.mockImplementation(
      async (text: string, params?: ReadonlyArray<unknown>) => {
        h.calls.push({ text, params })
        if (text.includes(`SELECT filename FROM ${MIGRATION_TRACKING_TABLE}`)) {
          return { rows: [], rowCount: 0 }
        }
        if (text.includes("CREATE TABLE") && text.includes("intent_audit")) {
          throw new Error("boom: syntax error")
        }
        return { rows: [], rowCount: 0 }
      },
    )
    await expect(
      runAuditMigrations(h.client, { migrationsDir: MIGRATIONS_DIR, now: NOW }),
    ).rejects.toThrow(/Migration 001-.*failed: boom/)
    expect(h.calls.some((c) => c.text === "ROLLBACK")).toBe(true)
    expect(h.calls.some((c) => c.text === "COMMIT")).toBe(false)
  })
})
