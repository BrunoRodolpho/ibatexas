// Audit-postgres migration runner for the RC-A1 kernel cutover.
//
// The `@claustrum/*` Conductor's audit sink (apps/api/src/claustrum-bootstrap.ts)
// writes one `intent_audit` row BEFORE every money side-effect. That table — and
// its companions (governance_events, audit_guard_stats, audit_outcomes) — live in
// `@adjudicate/audit-postgres/migrations/00{1..8}-*.sql`, a migration set that
// `ibx bootstrap`'s Medusa + domain-prisma steps do NOT apply. This runner closes
// that gap: it applies those migrations against the runtime `DATABASE_URL` (the
// same connection the sink uses) and pre-creates the monthly partitions that the
// RANGE-partitioned `intent_audit` parent requires before any row can be written.
//
// Two correctness properties the migration files force on us:
//   1. APPLY-ONCE. Migrations 001/002/004/005 carry bare `ADD CONSTRAINT`
//      statements (no `IF NOT EXISTS`) — re-running them throws "constraint
//      already exists". So we track applied files in `adjudicate_audit_migrations`
//      and run each exactly once. That makes the whole step idempotent.
//   2. PARTITIONS. `intent_audit` is `PARTITION BY RANGE (recorded_at)` with NO
//      partitions created by any migration. An INSERT whose `recorded_at` falls
//      outside every partition is rejected. We create `CREATE TABLE IF NOT EXISTS
//      … PARTITION OF …` for a window of months around "now" so live writes land.
//      Ongoing month-rollover is operational (pg_partman or a monthly re-run).

import fs from "node:fs"
import path from "node:path"

/** The migrations the kernel audit sink depends on. */
export const AUDIT_MIGRATION_FILE_RE = /^\d{3}-.*\.sql$/

/** Bookkeeping table — one row per applied migration file. */
export const MIGRATION_TRACKING_TABLE = "adjudicate_audit_migrations"

/**
 * Minimal node-postgres client surface this runner needs. `pg.Client` and
 * `pg.Pool` both satisfy it; tests inject a mock. Kept structural so the lib
 * never imports `pg` directly (the command/bootstrap own the connection).
 */
export interface PgClientLike {
  query(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/** One monthly partition of `intent_audit`. Bounds are half-open [from, to). */
export interface PartitionSpec {
  readonly name: string
  readonly from: string // 'YYYY-MM-01 00:00:00+00'
  readonly to: string // first day of the following month, +00
}

export interface MigrateOptions {
  readonly migrationsDir: string
  /** Reference instant for the partition window. Injected for determinism. */
  readonly now: Date
  /** Months of partitions to create before `now` (default 1). */
  readonly partitionsBack?: number
  /** Months of partitions to create at/after `now` (default 3 → current + 3). */
  readonly partitionsForward?: number
  readonly log?: (msg: string) => void
}

export interface MigrateResult {
  readonly applied: string[]
  readonly skipped: string[]
  readonly partitionsEnsured: string[]
}

/**
 * Locate the `@adjudicate/audit-postgres` migrations directory. The CLI does not
 * depend on the package directly (and its `exports` map blocks `require.resolve`
 * of `package.json`), so we probe the known workspace layouts in order:
 *   1. explicit `ADJUDICATE_AUDIT_MIGRATIONS_DIR` override (CI / non-standard)
 *   2. the apps/api workspace symlink (the consumer that DOES depend on it)
 *   3. a root-level node_modules link
 *   4. the sibling checkout that pnpm-workspace.yaml hard-codes (`../adjudicate/…`)
 */
export function resolveAuditMigrationsDir(root: string, override?: string): string {
  const candidates = [
    override,
    process.env.ADJUDICATE_AUDIT_MIGRATIONS_DIR,
    path.join(root, "apps/api/node_modules/@adjudicate/audit-postgres/migrations"),
    path.join(root, "node_modules/@adjudicate/audit-postgres/migrations"),
    path.join(root, "../adjudicate/packages/audit-postgres/migrations"),
  ].filter((c): c is string => Boolean(c))

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      // Confirm it actually holds migration files (guards against a stale dir).
      if (fs.readdirSync(dir).some((f) => AUDIT_MIGRATION_FILE_RE.test(f))) {
        return dir
      }
    }
  }
  throw new Error(
    "Could not locate @adjudicate/audit-postgres migrations. Looked in:\n  " +
      candidates.join("\n  ") +
      "\nSet ADJUDICATE_AUDIT_MIGRATIONS_DIR to override.",
  )
}

/** Sorted list of migration filenames (001-… before 002-…). */
export function listMigrationFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => AUDIT_MIGRATION_FILE_RE.test(f))
    .sort()
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Monthly partition specs covering [now - back, now + forward] months. Bounds are
 * pinned to UTC month boundaries (`+00`) so they match the kernel's ISO-8601
 * `recorded_at` instants regardless of the server timezone.
 */
export function monthlyPartitionSpecs(
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
      name: `intent_audit_${y}_${m}`,
      from: `${y}-${m}-01 00:00:00+00`,
      to: `${ny}-${nm}-01 00:00:00+00`,
    })
  }
  return specs
}

/** CREATE TABLE IF NOT EXISTS … PARTITION OF … for one monthly partition. */
export function partitionStatement(spec: PartitionSpec): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${spec.name} PARTITION OF intent_audit ` +
    `FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`
  )
}

/**
 * Apply the audit-postgres migrations apply-once, then ensure the monthly
 * partitions exist. Safe to re-run: already-applied files are skipped and every
 * partition uses IF NOT EXISTS.
 *
 * Each migration file runs inside its own transaction together with the tracking
 * insert, so a partial failure leaves neither a half-applied schema nor a
 * bookkeeping row claiming success.
 */
export async function runAuditMigrations(
  client: PgClientLike,
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const log = opts.log ?? (() => {})
  const files = listMigrationFiles(opts.migrationsDir)
  if (files.length === 0) {
    throw new Error(`No migration files found in ${opts.migrationsDir}`)
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TRACKING_TABLE} (` +
      `filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  )

  const appliedRows = await client.query(
    `SELECT filename FROM ${MIGRATION_TRACKING_TABLE}`,
  )
  const alreadyApplied = new Set(
    appliedRows.rows.map((r) => String(r.filename)),
  )

  const applied: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file)
      log(`  ↷ ${file} (already applied)`)
      continue
    }
    const sql = fs.readFileSync(path.join(opts.migrationsDir, file), "utf8")
    try {
      await client.query("BEGIN")
      await client.query(sql)
      await client.query(
        `INSERT INTO ${MIGRATION_TRACKING_TABLE} (filename) VALUES ($1)`,
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
  // after 001 has created the partitioned parent (i.e. on this or a prior run).
  const partitionsEnsured: string[] = []
  const specs = monthlyPartitionSpecs(
    opts.now,
    opts.partitionsBack ?? 1,
    opts.partitionsForward ?? 3,
  )
  for (const spec of specs) {
    await client.query(partitionStatement(spec))
    partitionsEnsured.push(spec.name)
    log(`  ▸ partition ${spec.name} [${spec.from} … ${spec.to})`)
  }

  return { applied, skipped, partitionsEnsured }
}
