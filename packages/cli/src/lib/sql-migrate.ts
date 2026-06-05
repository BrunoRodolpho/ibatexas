// Generic raw-SQL migration runner shared by the kernel (intent_audit) and
// claustrum (memory + grounding) schema provisioners. Extracted from
// kernel-migrate.ts so a second consumer doesn't duplicate the apply-once /
// partition logic. kernel-migrate.ts and claustrum-migrate.ts are thin configs
// on top of this engine.
//
// Two correctness properties the migration files force on us:
//   1. APPLY-ONCE. Some migration files carry bare `ADD CONSTRAINT` statements
//      (no IF NOT EXISTS) — re-running them throws. We track applied files in a
//      per-layer tracking table and run each exactly once → idempotent.
//   2. PARTITIONS. RANGE-partitioned parents (intent_audit,
//      claustrum_memory_episodic) get NO partitions from any migration. A row
//      whose key falls outside every partition is rejected. The caller passes
//      `CREATE TABLE IF NOT EXISTS … PARTITION OF …` statements for a window of
//      months around "now" so live writes land.

import fs from "node:fs"
import path from "node:path"

/** Default migration-file pattern: `001-name.sql`, `002-name.sql`, … */
export const DEFAULT_MIGRATION_FILE_RE = /^\d{3}-.*\.sql$/

/**
 * Minimal node-postgres client surface this runner needs. `pg.Client` and
 * `pg.Pool` both satisfy it; tests inject a mock. Kept structural so this lib
 * never imports `pg` directly (the command/bootstrap own the connection).
 */
export interface PgClientLike {
  query(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/** One monthly partition. Bounds are half-open [from, to). */
export interface PartitionSpec {
  readonly name: string
  readonly from: string // 'YYYY-MM-01 00:00:00+00'
  readonly to: string // first day of the following month, +00
}

/** A pre-built partition DDL statement plus the partition name it ensures. */
export interface PartitionStatement {
  readonly name: string
  readonly sql: string
}

export interface SqlMigrateOptions {
  /** Migration directories, applied in array order; files within each sorted. */
  readonly migrationsDirs: string[]
  /** Bookkeeping table name — one row per applied migration file. */
  readonly trackingTable: string
  /** Which files count as migrations (default: 001-… .sql). */
  readonly fileRe?: RegExp
  /** Idempotent DDL run once before the file loop (e.g. CREATE EXTENSION). */
  readonly preStatements?: readonly string[]
  /** Partition DDL ensured after migrations (parent must exist first). */
  readonly partitions?: readonly PartitionStatement[]
  readonly log?: (msg: string) => void
}

export interface SqlMigrateResult {
  readonly applied: string[]
  readonly skipped: string[]
  readonly partitionsEnsured: string[]
}

/** Sorted migration filenames in `dir` (001-… before 002-…). */
export function listMigrationFiles(
  dir: string,
  fileRe: RegExp = DEFAULT_MIGRATION_FILE_RE,
): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => fileRe.test(f))
    .sort()
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Monthly partition specs for `parentTable` covering [now-back, now+forward]
 * months. Bounds are pinned to UTC month boundaries (`+00`) so they match
 * ISO-8601 timestamp instants regardless of the server timezone.
 */
export function monthlyPartitionSpecsFor(
  parentTable: string,
  now: Date,
  back = 1,
  forward = 3,
): PartitionSpec[] {
  const specs: PartitionSpec[] = []
  const baseYear = now.getUTCFullYear()
  const baseMonth = now.getUTCMonth() // 0-11

  for (let offset = -back; offset <= forward; offset++) {
    const start = new Date(Date.UTC(baseYear, baseMonth + offset, 1))
    const next = new Date(Date.UTC(baseYear, baseMonth + offset + 1, 1))
    const y = start.getUTCFullYear()
    const m = pad2(start.getUTCMonth() + 1)
    const ny = next.getUTCFullYear()
    const nm = pad2(next.getUTCMonth() + 1)
    specs.push({
      name: `${parentTable}_${y}_${m}`,
      from: `${y}-${m}-01 00:00:00+00`,
      to: `${ny}-${nm}-01 00:00:00+00`,
    })
  }
  return specs
}

/** CREATE TABLE IF NOT EXISTS … PARTITION OF `parentTable` for one month. */
export function partitionStatementFor(
  parentTable: string,
  spec: PartitionSpec,
): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${spec.name} PARTITION OF ${parentTable} ` +
    `FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`
  )
}

/**
 * Apply migration files apply-once, then ensure the requested partitions exist.
 * Safe to re-run: already-applied files are skipped and partitions/pre-statements
 * use IF NOT EXISTS. Each migration file runs inside its own transaction together
 * with the tracking insert, so a partial failure leaves neither a half-applied
 * schema nor a bookkeeping row claiming success.
 */
export async function runSqlMigrations(
  client: PgClientLike,
  opts: SqlMigrateOptions,
): Promise<SqlMigrateResult> {
  const log = opts.log ?? (() => {})
  const fileRe = opts.fileRe ?? DEFAULT_MIGRATION_FILE_RE

  // Ordered (dir, file) pairs: dirs in array order, files sorted within each.
  const entries: Array<{ dir: string; file: string }> = []
  for (const dir of opts.migrationsDirs) {
    for (const file of listMigrationFiles(dir, fileRe)) {
      entries.push({ dir, file })
    }
  }
  if (entries.length === 0) {
    throw new Error(
      `No migration files found in ${opts.migrationsDirs.join(", ")}`,
    )
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${opts.trackingTable} (` +
      `filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  )

  const appliedRows = await client.query(
    `SELECT filename FROM ${opts.trackingTable}`,
  )
  const alreadyApplied = new Set(appliedRows.rows.map((r) => String(r.filename)))

  for (const stmt of opts.preStatements ?? []) {
    await client.query(stmt)
    log(`  ⚙ ${stmt.split("\n")[0]}`)
  }

  const applied: string[] = []
  const skipped: string[] = []

  for (const { dir, file } of entries) {
    if (alreadyApplied.has(file)) {
      skipped.push(file)
      log(`  ↷ ${file} (already applied)`)
      continue
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8")
    try {
      await client.query("BEGIN")
      await client.query(sql)
      await client.query(
        `INSERT INTO ${opts.trackingTable} (filename) VALUES ($1)`,
        [file],
      )
      await client.query("COMMIT")
      applied.push(file)
      log(`  ✓ ${file}`)
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
    }
  }

  // Partitions must exist before the parent can accept a row. Create them only
  // after the partitioned parent exists (i.e. on this or a prior run).
  const partitionsEnsured: string[] = []
  for (const part of opts.partitions ?? []) {
    await client.query(part.sql)
    partitionsEnsured.push(part.name)
    log(`  ▸ partition ${part.name}`)
  }

  return { applied, skipped, partitionsEnsured }
}
