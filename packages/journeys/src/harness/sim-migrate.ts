// harness/sim-migrate.ts — apply-once runner for the journeys sim layer
// (T1b-5: sim_runs / sim_results, packages/journeys/migrations/*.sql).
//
// HOME OF THE LAYER (recorded choice): the sim tables are TEST-PLANE-ONLY,
// so they get a dedicated `ibx journey migrate` step wired into
// scripts/test-stack-up.sh ([2/4], right after `ibx db provision` +
// `ibx bootstrap`) instead of growing `ibx db provision` — that command is
// also run against dev/prod databases, which must never accrue journey-test
// tables. The cli command (packages/cli/src/commands/journey.ts) is THIN:
// it owns the pg connection (DATABASE_URL — the migration role, NOT the
// sim-writer role: DDL needs table ownership) and calls `migrateSimTables`.
//
// The runner mirrors the cli's lib/sql-migrate.ts semantics (apply-once via
// a per-layer tracking table) without importing it — journeys→cli is a
// forbidden dependency direction (D-010); the ~40 lines here are the cost of
// keeping the arrow pointing the right way. No partitions: the sim tables
// are plain (the partitioned kernel tables are NOT this layer's business).

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Apply-once ledger for this layer (one row per applied migration file). */
export const SIM_MIGRATIONS_TABLE = "journeys_sim_migrations"

/** Migration-file pattern shared with the other layers: `001-name.sql`, … */
const MIGRATION_FILE_RE = /^\d{3}-.*\.sql$/

/**
 * Minimal pg client surface (pg.Client and pg.Pool both satisfy it; tests
 * may inject a double). Kept structural so callers own the connection.
 */
export interface SimMigrateClient {
  query(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface SimMigrateResult {
  applied: string[]
  skipped: string[]
}

/**
 * The checked-in migrations dir (packages/journeys/migrations) — anchored at
 * this module so src/harness and dist/harness both resolve it.
 */
export function simMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations")
}

/**
 * Apply the journeys sim-layer migrations exactly once each (idempotent —
 * re-runs skip via the `journeys_sim_migrations` ledger). The caller owns
 * the client/connection lifecycle and must connect as a role that may CREATE
 * tables (the migration role, never ibx_sim_writer / ibx_oracle_ro).
 */
export async function migrateSimTables(
  client: SimMigrateClient,
  opts: { migrationsDir?: string; log?: (msg: string) => void } = {},
): Promise<SimMigrateResult> {
  const dir = opts.migrationsDir ?? simMigrationsDir()
  const log = opts.log ?? (() => undefined)
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort((a, b) => a.localeCompare(b))

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${SIM_MIGRATIONS_TABLE} (
       filename   text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )

  const applied: string[] = []
  const skipped: string[] = []
  for (const filename of files) {
    const seen = await client.query(
      `SELECT 1 FROM ${SIM_MIGRATIONS_TABLE} WHERE filename = $1`,
      [filename],
    )
    if (seen.rows.length > 0) {
      skipped.push(filename)
      continue
    }
    const sql = readFileSync(join(dir, filename), "utf8")
    await client.query(sql)
    await client.query(`INSERT INTO ${SIM_MIGRATIONS_TABLE} (filename) VALUES ($1)`, [
      filename,
    ])
    applied.push(filename)
    log(`applied ${filename}`)
  }

  return { applied, skipped }
}
