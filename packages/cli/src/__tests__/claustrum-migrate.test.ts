// Tests for lib/claustrum-migrate.ts — the @claustrum/* migration runner.
// Mocks the pg client; never connects to real Postgres. Reads the REAL
// @claustrum/memory-postgres + grounding-pgvector migration files.
import { describe, it, expect, beforeEach, vi } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CLAUSTRUM_MIGRATION_TRACKING_TABLE,
  resolveClaustrumMigrationsDirs,
  runClaustrumMigrations,
} from "../lib/claustrum-migrate.js"
import type { PgClientLike } from "../lib/sql-migrate.js"

// Repo root from this test file: packages/cli/src/__tests__ → up 4.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../")
const DIRS = resolveClaustrumMigrationsDirs(ROOT)
const NOW = new Date(Date.UTC(2026, 5, 15)) // 2026-06-15

interface Call {
  text: string
  params?: ReadonlyArray<unknown>
}

function makeClient(appliedFilenames: string[] = []) {
  const calls: Call[] = []
  const query = vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
    calls.push({ text, params })
    if (text.includes(`SELECT filename FROM ${CLAUSTRUM_MIGRATION_TRACKING_TABLE}`)) {
      return {
        rows: appliedFilenames.map((f) => ({ filename: f })),
        rowCount: appliedFilenames.length,
      }
    }
    return { rows: [], rowCount: 0 }
  })
  return { client: { query } as PgClientLike, calls, query }
}

describe("resolveClaustrumMigrationsDirs", () => {
  it("locates the memory-postgres + grounding-pgvector migration dirs", () => {
    expect(DIRS.length).toBeGreaterThanOrEqual(2)
    expect(DIRS.some((d) => d.includes("memory-postgres"))).toBe(true)
    expect(DIRS.some((d) => d.includes("grounding-pgvector"))).toBe(true)
  })

  it("honors a comma-separated override", () => {
    expect(resolveClaustrumMigrationsDirs(ROOT, "/a/migrations, /b/migrations")).toEqual([
      "/a/migrations",
      "/b/migrations",
    ])
  })
})

describe("runClaustrumMigrations — fresh database", () => {
  let h: ReturnType<typeof makeClient>
  let result: Awaited<ReturnType<typeof runClaustrumMigrations>>

  beforeEach(async () => {
    vi.clearAllMocks()
    h = makeClient([])
    result = await runClaustrumMigrations(h.client, { migrationsDirs: DIRS, now: NOW })
  })

  it("applies both the memory and grounding migrations", () => {
    expect(result.applied).toContain("001-create-claustrum-memory-episodic.sql")
    expect(result.applied).toContain("001-create-claustrum-grounding-docs.sql")
    expect(result.applied.length).toBeGreaterThanOrEqual(5)
    expect(result.skipped).toEqual([])
  })

  it("creates the claustrum tracking table before reading applied rows", () => {
    const createIdx = h.calls.findIndex((c) =>
      c.text.includes(`CREATE TABLE IF NOT EXISTS ${CLAUSTRUM_MIGRATION_TRACKING_TABLE}`),
    )
    const selectIdx = h.calls.findIndex((c) =>
      c.text.includes(`SELECT filename FROM ${CLAUSTRUM_MIGRATION_TRACKING_TABLE}`),
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

  it("ensures the monthly episodic partitions after migrations", () => {
    expect(result.partitionsEnsured).toContain("claustrum_memory_episodic_2026_06")
    const partCalls = h.calls.filter((c) =>
      c.text.includes("PARTITION OF claustrum_memory_episodic FOR VALUES"),
    )
    expect(partCalls.length).toBe(result.partitionsEnsured.length)
  })
})

describe("runClaustrumMigrations — idempotent re-run", () => {
  it("skips already-applied files but still ensures partitions", async () => {
    const fresh = makeClient([])
    const r1 = await runClaustrumMigrations(fresh.client, { migrationsDirs: DIRS, now: NOW })

    const h = makeClient(r1.applied)
    const r2 = await runClaustrumMigrations(h.client, { migrationsDirs: DIRS, now: NOW })

    expect(r2.applied).toEqual([])
    expect([...r2.skipped].sort()).toEqual([...r1.applied].sort())
    expect(h.calls.some((c) => c.text === "BEGIN")).toBe(false)
    expect(h.calls.some((c) => c.text.includes("PARTITION OF claustrum_memory_episodic"))).toBe(true)
  })
})

describe("runClaustrumMigrations — failure handling", () => {
  it("rolls back and surfaces the file name when a migration throws", async () => {
    const h = makeClient([])
    h.query.mockImplementation(async (text: string, params?: ReadonlyArray<unknown>) => {
      h.calls.push({ text, params })
      if (text.includes(`SELECT filename FROM ${CLAUSTRUM_MIGRATION_TRACKING_TABLE}`)) {
        return { rows: [], rowCount: 0 }
      }
      if (text.includes("CREATE TABLE") && text.includes("claustrum_memory_episodic")) {
        throw new Error("boom: syntax error")
      }
      return { rows: [], rowCount: 0 }
    })
    await expect(
      runClaustrumMigrations(h.client, { migrationsDirs: DIRS, now: NOW }),
    ).rejects.toThrow(/failed: boom/)
    expect(h.calls.some((c) => c.text === "ROLLBACK")).toBe(true)
  })
})
