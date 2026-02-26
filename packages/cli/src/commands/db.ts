import type { Command } from "commander"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDatabaseUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) {
    console.error(chalk.red("DATABASE_URL is not set. Run: ibx env check"))
    process.exit(1)
  }
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: url.port || "5433",
    user: url.username,
    password: url.password,
    dbName: url.pathname.slice(1),
  }
}

function getMedusaUrl(): string {
  const url = process.env.MEDUSA_BACKEND_URL
  if (!url) {
    console.error(chalk.red("MEDUSA_BACKEND_URL is not set. Run: ibx env check"))
    process.exit(1)
  }
  return url
}

async function medusaFetch(path: string): Promise<Record<string, unknown>> {
  const base = getMedusaUrl()
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Medusa API ${res.status}: ${text}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

async function runPsql(args: string[], env?: NodeJS.ProcessEnv) {
  await execa("psql", args, { stdio: "inherit", env: { ...process.env, ...env } })
}

// ── Sub-command implementations ───────────────────────────────────────────────

async function runMigrate() {
  const spinner = ora("Running Medusa migrations…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:migrate"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Migrations completed"))
  } catch {
    spinner.fail(chalk.red("Migration failed"))
    process.exit(1)
  }
}

async function runSeed() {
  const spinner = ora("Seeding database…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:seed"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Seed completed"))
  } catch {
    spinner.fail(chalk.red("Seed failed"))
    process.exit(1)
  }
}

async function runMigrateDomain() {
  const spinner = ora("Running domain (Prisma) migrations…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:migrate"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Domain migrations completed"))
  } catch {
    spinner.fail(chalk.red("Domain migration failed"))
    process.exit(1)
  }
}

async function runSeedDomain() {
  const spinner = ora("Seeding domain tables (Table + TimeSlots)…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:tables"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Domain seed completed"))
  } catch {
    spinner.fail(chalk.red("Domain seed failed"))
    process.exit(1)
  }
}

async function runReset(force = false) {
  if (!force) {
    const confirmed = await confirm({
      message: chalk.yellow(
        "⚠️  This will DROP the database and reseed from scratch. Continue?"
      ),
      default: false,
    })
    if (!confirmed) {
      console.log(chalk.gray("Aborted."))
      return
    }
  }

  const { host, port, user, password, dbName } = parseDatabaseUrl()
  // Sanitize dbName — only allow alphanumeric, underscores, hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
    console.error(chalk.red(`Invalid database name: "${dbName}". Only [a-zA-Z0-9_-] allowed.`))
    process.exit(1)
  }
  const pgEnv = password ? { PGPASSWORD: password } : {}
  const psqlBase = ["-h", host, "-p", port, "-U", user]

  const step = (msg: string) =>
    console.log(chalk.bold(`\n  ${chalk.cyan("→")} ${msg}`))

  step("Dropping database…")
  await runPsql(
    [...psqlBase, "postgres", "-c", `DROP DATABASE IF EXISTS "${dbName}"`],
    pgEnv
  )

  step("Creating database…")
  await runPsql(
    [...psqlBase, "postgres", "-c", `CREATE DATABASE "${dbName}"`],
    pgEnv
  )

  step("Running Medusa migrations…")
  await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:migrate"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  step("Running domain (Prisma) migrations…")
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:migrate"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  step("Seeding Medusa products…")
  await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:seed"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  step("Seeding domain tables…")
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:tables"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  console.log(chalk.green("\n  ✅  Database reset and reseed complete\n"))
}

async function runReindex(fresh = false) {
  const {
    ensureCollectionExists,
    recreateCollection,
    indexProductsBatch,
  } = await import("@ibatexas/tools")

  const step = (msg: string) =>
    console.log(chalk.bold(`\n  ${chalk.cyan("→")} ${msg}`))

  // 1. Create or recreate the collection
  if (fresh) {
    step("Recreating Typesense collection (--fresh)…")
    await recreateCollection()
    console.log(chalk.green("    Collection recreated"))
  } else {
    step("Ensuring Typesense collection exists…")
    await ensureCollectionExists()
    console.log(chalk.green("    Collection ready"))
  }

  // 2. Fetch all published products from Medusa (paginated)
  step("Fetching products from Medusa…")
  const allProducts: unknown[] = []
  let offset = 0
  const limit = 100

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await medusaFetch(
      `/admin/products?limit=${limit}&offset=${offset}&fields=id,title,description,thumbnail,status,tag_ids,variants,metadata,created_at,updated_at&expand=variants,variants.prices`
    )
    const products = (data.products as unknown[] | undefined) ?? []
    allProducts.push(...products)
    if (products.length < limit) break
    offset += limit
  }

  if (allProducts.length === 0) {
    console.log(chalk.yellow("\n  No products found in Medusa. Run: ibx db seed\n"))
    return
  }

  console.log(chalk.white(`    Found ${allProducts.length} product(s)`))

  // 3. Batch index into Typesense
  step(`Indexing ${allProducts.length} product(s) into Typesense…`)
  const spinner = ora("Generating embeddings & indexing…").start()
  try {
    await indexProductsBatch(allProducts)
    spinner.succeed(chalk.green(`Indexed ${allProducts.length} product(s) into Typesense`))
  } catch (err) {
    spinner.fail(chalk.red("Indexing failed"))
    console.error(err)
    process.exit(1)
  }

  console.log(chalk.green("\n  ✅  Reindex complete\n"))
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerDbCommands(program: Command) {
  const db = program
    .command("db")
    .description("Database operations (migrate, seed, reset)")

  db.command("migrate")
    .description("Run pending Medusa migrations (Medusa must NOT be running)")
    .action(runMigrate)

  db.command("migrate:domain")
    .description("Run pending Prisma (domain) migrations — Table, TimeSlot, Reservation, etc.")
    .action(runMigrateDomain)

  db.command("seed")
    .description("Run the Medusa seed file (Medusa must be running)")
    .action(runSeed)

  db.command("seed:domain")
    .description("Seed restaurant Tables and TimeSlots via Prisma")
    .action(runSeedDomain)

  db.command("reset")
    .description("⚠️  Drop + migrate (Medusa + domain) + reseed (destructive)")
    .option("-f, --force", "Skip the confirmation prompt")
    .action((opts: { force?: boolean }) => runReset(opts.force))

  db.command("reindex")
    .description("Fetch all products from Medusa and reindex into Typesense")
    .option("--fresh", "Drop and recreate the Typesense collection before indexing")
    .action((opts: { fresh?: boolean }) => runReindex(opts.fresh))

  return { runMigrate, runMigrateDomain, runSeed, runSeedDomain, runReset, runReindex }
}
