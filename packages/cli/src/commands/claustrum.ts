import type { Command } from "commander"
import chalk from "chalk"
import { Client } from "pg"
import { ROOT } from "../utils/root.js"
import {
  resolveClaustrumMigrationsDirs,
  runClaustrumMigrations,
} from "../lib/claustrum-migrate.js"
import type { SqlMigrateResult } from "../lib/sql-migrate.js"

// ── Shared helper (used by `ibx claustrum migrate`, `db provision`, `bootstrap`) ─

export interface MigrateClaustrumDbOptions {
  /** Defaults to process.env.DATABASE_URL. */
  databaseUrl?: string
  /** Explicit migration dirs (memory before grounding). Defaults to resolved. */
  migrationsDirs?: string[]
  /** Reference instant for the partition window (defaults to now). */
  now?: Date
  log?: (msg: string) => void
}

/**
 * Connect to the runtime DATABASE_URL (the same DB the claustrum memory/grounding
 * providers read) and apply the @claustrum/* migrations + episodic partitions.
 * Idempotent — see lib/claustrum-migrate.ts. Owns the pg connection lifecycle so
 * callers don't have to.
 */
export async function migrateClaustrumDatabase(
  opts: MigrateClaustrumDbOptions = {},
): Promise<SqlMigrateResult> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Run 'ibx env check' or pass --database-url.")
  }
  const migrationsDirs = opts.migrationsDirs ?? resolveClaustrumMigrationsDirs(ROOT)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await runClaustrumMigrations(client, {
      migrationsDirs,
      now: opts.now ?? new Date(),
      log: opts.log,
    })
  } finally {
    await client.end()
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerClaustrumCommands(program: Command) {
  program
    .command("migrate")
    .description(
      "Provision the @claustrum memory + grounding schema (episodic partitions + pgvector) in DATABASE_URL",
    )
    .option("--database-url <url>", "Override DATABASE_URL")
    .option("--migrations-dir <dirs>", "Override migration dirs (comma-separated)")
    .action(async (opts: { databaseUrl?: string; migrationsDir?: string }) => {
      console.log(chalk.bold.blue("\n  🧠  Claustrum schema migrate\n"))
      try {
        const migrationsDirs = opts.migrationsDir
          ? opts.migrationsDir.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined
        const result = await migrateClaustrumDatabase({
          databaseUrl: opts.databaseUrl,
          migrationsDirs,
          log: (msg) => console.log(chalk.gray(msg)),
        })
        console.log("")
        if (result.applied.length > 0) {
          console.log(chalk.green(`  ✅  Applied ${result.applied.length} migration(s).`))
        } else {
          console.log(chalk.green("  ✅  Schema already up to date (0 new migrations)."))
        }
        console.log(
          chalk.green(`  ✅  Ensured ${result.partitionsEnsured.length} monthly partition(s).`),
        )
        console.log("")
      } catch (err) {
        console.error(chalk.red(`\n  ❌  Claustrum migrate failed: ${(err as Error).message}\n`))
        process.exit(1)
      }
    })
}
