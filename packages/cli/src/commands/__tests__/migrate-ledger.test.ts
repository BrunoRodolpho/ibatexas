// Tests for the audit-postgres migration runner (`applyMigrationsWithLedger`).
//
// Regression: the old runner re-ran every SQL file from 001 on each invocation
// with no applied-migrations ledger, so on a database already advanced past the
// early migrations WITH data it aborted re-applying the constraint-NARROWING
// migration 005 (`CHECK (record_version IN (1,2,3))`, which existing v4 rows
// violate) and never reached the v5 migration 010 — breaking `ibx kernel
// migrate` / `ibx bootstrap`.
//
// Two suites:
//   1. Deterministic unit tests against a fake client (always run).
//   2. A live-Postgres integration test gated on INTEGRATION_TEST=1 that
//      reproduces the exact regression end-to-end.
//
// NOTE: this file intentionally does NOT mock `pg` (unlike kernel.test.ts) so
// the integration suite drives a real client.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  applyMigrationsWithLedger,
  loadAuditPostgresMigrations,
  type MigrationClient,
  type PendingMigration,
} from "../kernel.js"

// ── Fake client ────────────────────────────────────────────────────────────

interface FakeOpts {
  /** Migration filenames already recorded in the ledger. */
  preApplied?: readonly string[]
  /** Return a violated constraint name to make a migration body throw 23514. */
  checkViolationOn?: (sql: string) => string | null
  /** Make a migration body throw an "already exists" error. */
  alreadyExistsOn?: (sql: string) => boolean
  /**
   * Which queried constraint names the post-run `pg_constraint` re-assertion
   * sees as present + validated. Default: all queried names (the happy path).
   */
  validatedConstraints?: (queried: readonly string[]) => readonly string[]
}

interface FakeClient extends MigrationClient {
  readonly ledger: Set<string>
  readonly executed: string[]
}

function makeFakeClient(opts: FakeOpts = {}): FakeClient {
  const ledger = new Set<string>(opts.preApplied ?? [])
  const executed: string[] = []
  return {
    ledger,
    executed,
    async query(sql, params) {
      if (/CREATE TABLE IF NOT EXISTS audit_schema_migrations/i.test(sql)) {
        return { rows: [] }
      }
      if (/^SELECT filename FROM audit_schema_migrations/i.test(sql.trim())) {
        return { rows: [...ledger].map((filename) => ({ filename })) }
      }
      if (/INSERT INTO audit_schema_migrations/i.test(sql)) {
        ledger.add(String(params?.[0]))
        return { rows: [] }
      }
      if (/FROM pg_constraint WHERE conname = ANY/i.test(sql)) {
        const queried = (params?.[0] as string[] | undefined) ?? []
        const validated = opts.validatedConstraints
          ? opts.validatedConstraints(queried)
          : queried // default: everything queried is present + validated
        return { rows: validated.map((conname) => ({ conname })) }
      }
      // Otherwise: a migration body.
      executed.push(sql)
      const cv = opts.checkViolationOn?.(sql)
      if (cv) {
        const e = new Error(
          `check constraint "${cv}" of relation "thing" is violated by some row`,
        ) as Error & { code?: string }
        e.code = "23514"
        throw e
      }
      if (opts.alreadyExistsOn?.(sql)) {
        throw new Error('relation "thing" already exists')
      }
      return { rows: [] }
    },
  }
}

const noopLog = { info: () => {}, warn: () => {} }

const M = (file: string, sql: string): PendingMigration => ({ file, sql })

// Synthetic set mirroring the real record_version evolution: a narrowing
// intermediate (005) superseded by two widening migrations (008, 010).
const NARROW_SET: readonly PendingMigration[] = [
  M("001_init.sql", "CREATE TABLE IF NOT EXISTS thing (v INT)"),
  M("005_narrow.sql", "ALTER TABLE thing ADD CONSTRAINT thing_v_check CHECK (v IN (1,2,3))"),
  M("008_widen4.sql", "ALTER TABLE thing ADD CONSTRAINT thing_v_check CHECK (v IN (1,2,3,4))"),
  M("010_widen5.sql", "ALTER TABLE thing ADD CONSTRAINT thing_v_check CHECK (v IN (1,2,3,4,5))"),
]

describe("applyMigrationsWithLedger", () => {
  it("creates the ledger and records every migration on a fresh DB", async () => {
    const c = makeFakeClient()
    await applyMigrationsWithLedger(c, NARROW_SET, noopLog)
    expect([...c.ledger].sort()).toEqual([
      "001_init.sql",
      "005_narrow.sql",
      "008_widen4.sql",
      "010_widen5.sql",
    ])
    expect(c.executed).toHaveLength(4) // nothing skipped on a fresh DB
  })

  it("skips migrations already recorded in the ledger", async () => {
    const c = makeFakeClient({ preApplied: ["001_init.sql", "005_narrow.sql"] })
    await applyMigrationsWithLedger(c, NARROW_SET, noopLog)
    // Only the two unrecorded bodies execute.
    expect(c.executed).toEqual([
      "ALTER TABLE thing ADD CONSTRAINT thing_v_check CHECK (v IN (1,2,3,4))",
      "ALTER TABLE thing ADD CONSTRAINT thing_v_check CHECK (v IN (1,2,3,4,5))",
    ])
    expect(c.ledger.size).toBe(4)
  })

  it("skips a superseded narrowing migration that existing data is ahead of", async () => {
    // 005 narrows to IN (1,2,3); a v4 row makes it throw 23514. 008 + 010
    // re-define thing_v_check, so 005 is a superseded intermediate → recorded
    // and skipped, and the run continues to completion.
    const c = makeFakeClient({
      checkViolationOn: (sql) =>
        /CHECK \(v IN \(1,2,3\)\)/.test(sql) ? "thing_v_check" : null,
    })
    await expect(
      applyMigrationsWithLedger(c, NARROW_SET, noopLog),
    ).resolves.toBeUndefined()
    expect([...c.ledger].sort()).toEqual([
      "001_init.sql",
      "005_narrow.sql",
      "008_widen4.sql",
      "010_widen5.sql",
    ])
  })

  it("ABORTS if a superseded-skipped constraint is not validated after the run", async () => {
    // 005 is skipped as superseded, but the post-run pg_constraint re-assertion
    // reports thing_v_check as NOT present+validated (e.g. a later migration
    // re-added it NOT VALID) → the run must refuse to report success.
    const c = makeFakeClient({
      checkViolationOn: (sql) =>
        /CHECK \(v IN \(1,2,3\)\)/.test(sql) ? "thing_v_check" : null,
      validatedConstraints: () => [], // nothing comes back validated
    })
    await expect(
      applyMigrationsWithLedger(c, NARROW_SET, noopLog),
    ).rejects.toThrow(/superseded-skip left constraint\(s\) absent or unvalidated/)
  })

  it("ABORTS on a check_violation against the FINAL constraint (no later redefinition)", async () => {
    // Only 010 present; nothing supersedes it → a violation is a real error.
    const finalOnly = [
      M(
        "010_widen5.sql",
        "ALTER TABLE thing ADD CONSTRAINT thing_v_check CHECK (v IN (1,2,3,4,5))",
      ),
    ]
    const c = makeFakeClient({ checkViolationOn: () => "thing_v_check" })
    await expect(
      applyMigrationsWithLedger(c, finalOnly, noopLog),
    ).rejects.toThrow(/010_widen5\.sql failed/)
    expect(c.ledger.has("010_widen5.sql")).toBe(false)
  })

  it("treats an 'already exists' additive failure as already applied", async () => {
    const c = makeFakeClient({ alreadyExistsOn: () => true })
    await expect(
      applyMigrationsWithLedger(c, [M("001_init.sql", "CREATE TABLE thing (v INT)")], noopLog),
    ).resolves.toBeUndefined()
    expect(c.ledger.has("001_init.sql")).toBe(true)
  })

  it("propagates a non-constraint, non-duplicate failure", async () => {
    const c: MigrationClient = {
      async query(sql) {
        if (/audit_schema_migrations/i.test(sql)) return { rows: [] }
        throw new Error("syntax error at or near \"GARBAGE\"")
      },
    }
    await expect(
      applyMigrationsWithLedger(c, [M("001.sql", "GARBAGE")], noopLog),
    ).rejects.toThrow(/001\.sql failed: syntax error/)
  })
})

// ── Integration (live Postgres, gated on INTEGRATION_TEST=1) ─────────────────

const INTEGRATION = process.env.INTEGRATION_TEST === "1"
const describeIntegration = INTEGRATION ? describe : describe.skip

describeIntegration(
  "applyMigrationsWithLedger — live Postgres (INTEGRATION_TEST=1)",
  () => {
    // Throwaway schema so the real `intent_audit` is never touched.
    const SCHEMA = "ibx_migrate_runner_it"
    let client: import("pg").Client
    let migrations: PendingMigration[]

    beforeAll(async () => {
      const url = process.env.DATABASE_URL ?? process.env.PG_TEST_URL
      if (!url) {
        throw new Error(
          "INTEGRATION_TEST=1 requires DATABASE_URL or PG_TEST_URL",
        )
      }
      const { default: pg } = await import("pg")
      client = new pg.Client({ connectionString: url })
      await client.connect()
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path TO ${SCHEMA}`)
      migrations = await loadAuditPostgresMigrations()
    })

    afterAll(async () => {
      if (client) {
        await client
          .query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
          .catch(() => {})
        await client.end()
      }
    })

    it("re-runs cleanly on a DB provisioned through 008 with a v4 row, reaching v5", async () => {
      const wrap = client as unknown as MigrationClient

      // 1. Provision through 008 directly — simulating a pre-ledger evolved DB.
      const through008 = migrations.filter(
        (m) => Number.parseInt(m.file.slice(0, 3), 10) <= 8,
      )
      for (const m of through008) await client.query(m.sql)

      // 2. Partition + a v4 row so re-running 005 (CHECK IN (1,2,3)) would fail.
      await client.query(
        `CREATE TABLE IF NOT EXISTS intent_audit_it_2026_06 PARTITION OF intent_audit ` +
          `FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')`,
      )
      await client.query(
        `INSERT INTO intent_audit ` +
          `(intent_hash, session_id, kind, principal, taint, decision_kind, ` +
          ` decision_basis, envelope_jsonb, decision_jsonb, recorded_at, ` +
          ` duration_ms, partition_month, record_version) ` +
          `VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
        [
          "a".repeat(64),
          "sess_it",
          "order.it",
          "user",
          "TRUSTED",
          "EXECUTE",
          ["kernel:it"],
          "{}",
          "{}",
          "2026-06-15T00:00:00Z",
          1,
          "2026-06",
          4,
        ],
      )

      // 3. Run the full ledgered migrate over ALL migrations. The old runner
      //    would abort here re-applying 005; the new one skips it as superseded.
      await applyMigrationsWithLedger(wrap, migrations, noopLog)

      // 4. Final constraint admits v5, metadata_jsonb exists, ledger complete.
      const def = await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint ` +
          `WHERE conname='intent_audit_record_version_check' ` +
          `AND conrelid='intent_audit'::regclass`,
      )
      expect(String(def.rows[0]?.def)).toMatch(/1,\s*2,\s*3,\s*4,\s*5/)

      const col = await client.query(
        `SELECT 1 FROM information_schema.columns ` +
          `WHERE table_schema=$1 AND table_name='intent_audit' ` +
          `AND column_name='metadata_jsonb'`,
        [SCHEMA],
      )
      expect(col.rows).toHaveLength(1)

      const ledger = await client.query(
        `SELECT filename FROM audit_schema_migrations`,
      )
      expect(ledger.rows).toHaveLength(migrations.length)

      // The original v4 row survived (no data loss).
      const rows = await client.query(
        `SELECT record_version FROM intent_audit WHERE session_id='sess_it'`,
      )
      expect(rows.rows[0]?.record_version).toBe(4)
    })

    it("is a no-op on the second run (everything recorded in the ledger)", async () => {
      const calls: string[] = []
      const spy: MigrationClient = {
        query: (sql, params) => {
          calls.push(sql)
          return (client as unknown as MigrationClient).query(sql, params)
        },
      }
      await applyMigrationsWithLedger(spy, migrations, noopLog)
      // No migration body should execute — only the ledger CREATE + SELECT.
      const ranBodies = calls.filter(
        (s) =>
          !/audit_schema_migrations/i.test(s) &&
          !/^SELECT filename/i.test(s.trim()),
      )
      expect(ranBodies).toHaveLength(0)
    })
  },
)
