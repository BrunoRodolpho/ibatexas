// Audit-postgres migration runner for the RC-A1 kernel cutover.
//
// The `@claustrum/*` Conductor's audit sink (apps/api/src/claustrum-bootstrap.ts)
// writes one `intent_audit` row BEFORE every money side-effect. That table — and
// its companions (governance_events, audit_guard_stats, audit_outcomes) — live in
// `@adjudicate/audit-postgres/migrations/00{1..8}-*.sql`, a migration set that
// `ibx bootstrap`'s Medusa + domain-prisma steps do NOT apply. This module is a
// thin config over the generic runner in `sql-migrate.ts`: it locates those
// migrations, runs them apply-once against the runtime `DATABASE_URL`, and
// pre-creates the monthly partitions the RANGE-partitioned `intent_audit` parent
// requires before any row can be written.
//
// Public exports here are kept stable on purpose — `commands/kernel.ts`,
// `commands/bootstrap.ts`, and the existing test suite depend on them.

import fs from "node:fs"
import path from "node:path"
import {
  monthlyPartitionSpecsFor,
  partitionStatementFor,
  runSqlMigrations,
  type PartitionSpec,
  type PgClientLike,
  type SqlMigrateResult,
} from "./sql-migrate.js"

// Re-exported so existing importers keep their single import site.
export { listMigrationFiles } from "./sql-migrate.js"
export { type PartitionSpec, type PgClientLike }

/** The migrations the kernel audit sink depends on. */
export const AUDIT_MIGRATION_FILE_RE = /^\d{3}-.*\.sql$/

/** Bookkeeping table — one row per applied migration file. */
export const MIGRATION_TRACKING_TABLE = "adjudicate_audit_migrations"

/** The RANGE-partitioned parent table the audit sink writes to. */
const PARTITION_PARENT = "intent_audit"

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

export type MigrateResult = SqlMigrateResult

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

/**
 * Monthly partition specs for `intent_audit` covering [now-back, now+forward].
 * Kept as a kernel-specific wrapper so callers/tests get `intent_audit_*` names.
 */
export function monthlyPartitionSpecs(
  now: Date,
  back = 1,
  forward = 3,
): PartitionSpec[] {
  return monthlyPartitionSpecsFor(PARTITION_PARENT, now, back, forward)
}

/** CREATE TABLE IF NOT EXISTS … PARTITION OF intent_audit for one month. */
export function partitionStatement(spec: PartitionSpec): string {
  return partitionStatementFor(PARTITION_PARENT, spec)
}

/**
 * Apply the audit-postgres migrations apply-once, then ensure the monthly
 * `intent_audit` partitions exist. Idempotent — see `sql-migrate.ts`.
 */
export async function runAuditMigrations(
  client: PgClientLike,
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const specs = monthlyPartitionSpecs(
    opts.now,
    opts.partitionsBack ?? 1,
    opts.partitionsForward ?? 3,
  )
  return runSqlMigrations(client, {
    migrationsDirs: [opts.migrationsDir],
    trackingTable: MIGRATION_TRACKING_TABLE,
    fileRe: AUDIT_MIGRATION_FILE_RE,
    partitions: specs.map((s) => ({ name: s.name, sql: partitionStatement(s) })),
    log: opts.log,
  })
}
