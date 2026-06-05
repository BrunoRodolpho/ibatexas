// Claustrum schema migration runner — the memory + grounding companion to
// kernel-migrate.ts.
//
// `@claustrum/memory-postgres` (episodic/semantic/procedural/relational) and
// `@claustrum/grounding-pgvector` (grounding docs, pgvector) ship raw-SQL
// migrations that NOTHING in `ibx` applied until now — `db reset` would DROP the
// database and never recreate them. This module is a thin config over the
// generic runner in `sql-migrate.ts`: it locates BOTH migration dirs, runs them
// apply-once against the runtime `DATABASE_URL`, and pre-creates the monthly
// partitions the RANGE-partitioned `claustrum_memory_episodic` parent requires.
//
// The grounding migration self-creates the pgvector extension
// (`CREATE EXTENSION IF NOT EXISTS vector`), which needs a superuser role — in
// the Docker dev Postgres the default role is superuser; in managed Postgres a
// DBA pre-creates the extension once.

import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_MIGRATION_FILE_RE,
  monthlyPartitionSpecsFor,
  partitionStatementFor,
  runSqlMigrations,
  type PgClientLike,
  type SqlMigrateResult,
} from "./sql-migrate.js"

/** Bookkeeping table — one row per applied claustrum migration file. */
export const CLAUSTRUM_MIGRATION_TRACKING_TABLE = "claustrum_migrations"

/** The RANGE-partitioned parent table claustrum's episodic memory writes to. */
const PARTITION_PARENT = "claustrum_memory_episodic"

/** The two @claustrum/* packages that ship raw-SQL migrations, in apply order. */
const CLAUSTRUM_MIGRATION_PACKAGES = [
  "@claustrum/memory-postgres",
  "@claustrum/grounding-pgvector",
] as const

export interface ClaustrumMigrateOptions {
  /** Migration dirs (memory before grounding). Defaults to the resolved dirs. */
  readonly migrationsDirs: string[]
  /** Reference instant for the partition window. Injected for determinism. */
  readonly now: Date
  readonly partitionsBack?: number
  readonly partitionsForward?: number
  readonly log?: (msg: string) => void
}

/** Probe the known workspace layouts for one package's migrations dir. */
function probePackageMigrationsDir(root: string, pkg: string): string | null {
  const local = pkg.replace("@claustrum/", "")
  const candidates = [
    path.join(root, `apps/api/node_modules/${pkg}/migrations`),
    path.join(root, `node_modules/${pkg}/migrations`),
    path.join(root, `../claustrum/packages/${local}/migrations`),
  ]
  for (const dir of candidates) {
    if (
      fs.existsSync(dir) &&
      fs.statSync(dir).isDirectory() &&
      fs.readdirSync(dir).some((f) => DEFAULT_MIGRATION_FILE_RE.test(f))
    ) {
      return dir
    }
  }
  return null
}

/**
 * Locate the `@claustrum/*` migration directories (memory-postgres, then
 * grounding-pgvector). Mirrors `resolveAuditMigrationsDir`'s probing. An explicit
 * `CLAUSTRUM_MIGRATIONS_DIR` (or the `override` arg) — comma-separated — bypasses
 * probing for CI / non-standard layouts.
 */
export function resolveClaustrumMigrationsDirs(
  root: string,
  override?: string,
): string[] {
  const explicit = override ?? process.env.CLAUSTRUM_MIGRATIONS_DIR
  if (explicit) {
    return explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  const dirs: string[] = []
  const missing: string[] = []
  for (const pkg of CLAUSTRUM_MIGRATION_PACKAGES) {
    const dir = probePackageMigrationsDir(root, pkg)
    if (dir) dirs.push(dir)
    else missing.push(pkg)
  }
  if (dirs.length === 0) {
    throw new Error(
      `Could not locate @claustrum/* migrations (missing: ${missing.join(", ")}).\n` +
        "Set CLAUSTRUM_MIGRATIONS_DIR (comma-separated dirs) to override.",
    )
  }
  return dirs
}

/**
 * Apply the claustrum migrations apply-once across both packages, then ensure the
 * monthly `claustrum_memory_episodic` partitions exist. Idempotent — already
 * applied files are skipped; the migration DDL is all `IF NOT EXISTS`.
 */
export async function runClaustrumMigrations(
  client: PgClientLike,
  opts: ClaustrumMigrateOptions,
): Promise<SqlMigrateResult> {
  const specs = monthlyPartitionSpecsFor(
    PARTITION_PARENT,
    opts.now,
    opts.partitionsBack ?? 1,
    opts.partitionsForward ?? 3,
  )
  return runSqlMigrations(client, {
    migrationsDirs: opts.migrationsDirs,
    trackingTable: CLAUSTRUM_MIGRATION_TRACKING_TABLE,
    partitions: specs.map((s) => ({
      name: s.name,
      sql: partitionStatementFor(PARTITION_PARENT, s),
    })),
    log: opts.log,
  })
}
