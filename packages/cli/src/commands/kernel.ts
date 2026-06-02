import type { Command } from "commander"
import chalk from "chalk"
import { Client } from "pg"
import { ROOT } from "../utils/root.js"
import {
  resolveAuditMigrationsDir,
  runAuditMigrations,
  type MigrateResult,
} from "../lib/kernel-migrate.js"

// ── Shared helper (used by `ibx kernel migrate` AND `ibx bootstrap`) ──────────

export interface MigrateAuditDbOptions {
  /** Defaults to process.env.DATABASE_URL. */
  databaseUrl?: string
  /** Defaults to the resolved @adjudicate/audit-postgres migrations dir. */
  migrationsDir?: string
  /** Reference instant for the partition window (defaults to now). */
  now?: Date
  log?: (msg: string) => void
}

/**
 * Connect to the runtime DATABASE_URL (the same DB the kernel audit sink writes
 * to) and apply the audit-postgres migrations + partitions. Idempotent — see
 * lib/kernel-migrate.ts. Owns the pg connection lifecycle so callers don't have
 * to. Provisions the `intent_audit` table the kernel audit sink writes to.
 */
export async function migrateAuditDatabase(
  opts: MigrateAuditDbOptions = {},
): Promise<MigrateResult> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Run 'ibx env check' or pass --database-url.")
  }
  const migrationsDir = opts.migrationsDir ?? resolveAuditMigrationsDir(ROOT)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await runAuditMigrations(client, {
      migrationsDir,
      now: opts.now ?? new Date(),
      log: opts.log,
    })
  } finally {
    await client.end()
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerKernelCommands(program: Command) {
  program
    .command("migrate")
    .description(
      "Provision the @adjudicate kernel audit schema (intent_audit + partitions) in DATABASE_URL",
    )
    .option("--database-url <url>", "Override DATABASE_URL")
    .option("--migrations-dir <dir>", "Override the audit-postgres migrations directory")
    .action(async (opts: { databaseUrl?: string; migrationsDir?: string }) => {
      console.log(chalk.bold.blue("\n  🔐  Kernel audit-schema migrate\n"))
      try {
        const result = await migrateAuditDatabase({
          databaseUrl: opts.databaseUrl,
          migrationsDir: opts.migrationsDir,
          log: (msg) => console.log(chalk.gray(msg)),
        })
        console.log("")
        if (result.applied.length > 0) {
          console.log(
            chalk.green(`  ✅  Applied ${result.applied.length} migration(s).`),
          )
        } else {
          console.log(chalk.green("  ✅  Schema already up to date (0 new migrations)."))
        }
        console.log(
          chalk.green(`  ✅  Ensured ${result.partitionsEnsured.length} monthly partition(s).`),
        )
        console.log("")
      } catch (err) {
        console.error(chalk.red(`\n  ❌  Kernel migrate failed: ${(err as Error).message}\n`))
        process.exit(1)
      }
    })
}
