import type { Command } from "commander"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"
import { guardDestructive } from "../lib/pipeline.js"
import { getMedusaUrl, getAdminToken, medusaFetch } from "../lib/medusa.js"

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

async function runSeedHomepage() {
  const spinner = ora("Seeding homepage data (customers + reviews)…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:homepage"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Homepage seed completed"))
  } catch {
    spinner.fail(chalk.red("Homepage seed failed"))
    process.exit(1)
  }
}

async function runSeedDelivery() {
  const spinner = ora("Seeding delivery data (zones + addresses + preferences)…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:delivery"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Delivery seed completed"))
  } catch {
    spinner.fail(chalk.red("Delivery seed failed"))
    process.exit(1)
  }
}

async function runSeedOrders() {
  const spinner = ora("Seeding order history + reservations (Medusa must be running)…").start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:orders"], {
      cwd: ROOT,
      stdio: "inherit",
    })
    spinner.succeed(chalk.green("Orders seed completed"))
  } catch {
    spinner.fail(chalk.red("Orders seed failed"))
    process.exit(1)
  }
}

async function runReset(force = false) {
  guardDestructive("db reset")
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
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:push"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  const adminEmail = process.env.MEDUSA_ADMIN_EMAIL
  const adminPassword = process.env.MEDUSA_ADMIN_PASSWORD
  if (!adminEmail || !adminPassword) {
    throw new Error(
      "MEDUSA_ADMIN_EMAIL e MEDUSA_ADMIN_PASSWORD devem estar definidos no .env",
    )
  }
  step(`Creating admin user (${adminEmail})…`)
  await execa(
    "npx",
    ["medusa", "user", "--email", adminEmail, "--password", adminPassword],
    { cwd: `${ROOT}/apps/commerce`, stdio: "inherit" }
  )

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

  step("Seeding homepage data (customers + reviews)…")
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:homepage"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  step("Seeding delivery data (zones + addresses + preferences)…")
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:delivery"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  step("Seeding order history + reservations…")
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:orders"], {
    cwd: ROOT,
    stdio: "inherit",
  })

  console.log(chalk.green("\n  ✅  Database reset and reseed complete\n"))
}

async function runClean(opts: { force?: boolean; all?: boolean } = {}) {
  guardDestructive("db clean")
  const scope = opts.all ? "ALL data (domain + Medusa products + Typesense + Redis)" : "domain data (customers, reservations, reviews, etc.)"

  if (!opts.force) {
    const confirmed = await confirm({
      message: chalk.yellow(`⚠️  This will DELETE ${scope}. Continue?`),
      default: false,
    })
    if (!confirmed) {
      console.log(chalk.gray("Aborted."))
      return
    }
  }

  const step = (msg: string) =>
    console.log(chalk.bold(`\n  ${chalk.cyan("→")} ${msg}`))

  // ── Domain tables (FK-safe order: children first) ───────────────────────
  step("Cleaning domain tables…")
  try {
    const { prisma } = await import("@ibatexas/domain")

    await prisma.reservationTable.deleteMany()
    await prisma.waitlist.deleteMany()
    await prisma.reservation.deleteMany()
    await prisma.review.deleteMany()
    await prisma.customerOrderItem.deleteMany()
    await prisma.address.deleteMany()
    await prisma.customerPreferences.deleteMany()
    await prisma.customer.deleteMany()
    await prisma.timeSlot.deleteMany()
    await prisma.table.deleteMany()
    await prisma.deliveryZone.deleteMany()

    console.log(chalk.green("    All domain tables emptied"))
    await prisma.$disconnect()
  } catch (err) {
    console.log(chalk.red(`    Domain clean failed: ${(err as Error).message}`))
  }

  // ── Medusa products (--all only) ────────────────────────────────────────
  if (opts.all) {
    step("Deleting Medusa products…")
    try {
      const token = await getAdminToken()
      const base = getMedusaUrl()
      const data = await medusaFetch<Record<string, unknown>>("/admin/products?limit=200&fields=id", { token })
      const products = (data.products as Array<{ id: string }>) ?? []

      for (const product of products) {
        await fetch(`${base}/admin/products/${product.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        })
      }
      console.log(chalk.green(`    Deleted ${products.length} Medusa product(s)`))
    } catch (err) {
      console.log(chalk.yellow(`    Medusa clean skipped: ${(err as Error).message}`))
    }

    step("Clearing Typesense index…")
    try {
      const { recreateCollection } = await import("@ibatexas/tools")
      await recreateCollection()
      console.log(chalk.green("    Typesense collection recreated (empty)"))
    } catch {
      console.log(chalk.yellow("    Typesense clean skipped"))
    }
  }

  // ── Redis cache ─────────────────────────────────────────────────────────
  step("Clearing Redis cache…")
  try {
    const { invalidateAllQueryCache, closeRedisClient } = await import("@ibatexas/tools")
    await invalidateAllQueryCache()
    console.log(chalk.green("    Query cache cleared"))
    await closeRedisClient()
  } catch {
    console.log(chalk.yellow("    Redis clean skipped (Redis unavailable)"))
  }

  console.log(chalk.green("\n  ✅  Clean complete\n"))
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

  // 2. Authenticate with Medusa admin API
  step("Authenticating with Medusa admin API…")
  let token: string
  try {
    token = await getAdminToken()
    console.log(chalk.green("    Authenticated"))
  } catch (err) {
    console.error(chalk.red(`    ${String(err)}`))
    process.exit(1)
  }

  // 3. Fetch all published products from Medusa (paginated)
  step("Fetching products from Medusa…")
  const allProducts: unknown[] = []
  let offset = 0
  const limit = 100

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await medusaFetch<Record<string, unknown>>(
      `/admin/products?limit=${limit}&offset=${offset}&fields=*variants,*variants.price_set,*variants.price_set.prices,*tags,*categories,*images`,
      { token },
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

  // 4. Batch index into Typesense
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

  // 5. Flush search cache so stale empty results don't persist
  step("Flushing search cache…")
  try {
    const { invalidateAllQueryCache, closeRedisClient } = await import("@ibatexas/tools")
    await invalidateAllQueryCache()
    console.log(chalk.green("    Search cache cleared"))
    await closeRedisClient()
  } catch {
    console.log(chalk.yellow("    Cache flush skipped (Redis unavailable)"))
  }

  console.log(chalk.green("\n  ✅  Reindex complete\n"))
}

async function runStatus() {
  console.log(chalk.bold("\n  ibx db status\n"))

  const step = (msg: string) =>
    console.log(chalk.bold(`  ${chalk.cyan("●")} ${msg}\n`))

  // ── Medusa migrations ─────────────────────────────────────────────────────
  step("Medusa (MikroORM)")
  try {
    const result = await execa("pnpm", ["--filter", "@ibatexas/commerce", "exec", "medusa", "db:migrate", "--skip"], {
      cwd: ROOT,
      reject: false,
    })
    // If --skip is not supported, try just showing current state
    if (result.exitCode === 0) {
      console.log(chalk.green("    Migrations up to date"))
    } else {
      // Fallback: check if Medusa command responds at all
      const healthCheck = await execa("pnpm", ["--filter", "@ibatexas/commerce", "exec", "medusa", "--version"], {
        cwd: ROOT,
        reject: false,
      })
      if (healthCheck.exitCode === 0) {
        console.log(chalk.white(`    Medusa ${healthCheck.stdout.trim()}`))
        console.log(chalk.yellow("    Run ibx db migrate to apply pending migrations"))
      } else {
        console.log(chalk.yellow("    Cannot determine migration status (Medusa CLI not available)"))
      }
    }
  } catch {
    console.log(chalk.yellow("    Cannot determine Medusa migration status"))
  }

  console.log()

  // ── Domain (Prisma) migrations ────────────────────────────────────────────
  step("Domain (Prisma — ibx_domain)")
  try {
    const result = await execa(
      "pnpm", ["--filter", "@ibatexas/domain", "exec", "prisma", "migrate", "status"],
      { cwd: ROOT, reject: false }
    )
    const output = (result.stdout + "\n" + result.stderr).trim()

    // Parse Prisma migrate status output
    const lines = output.split("\n").filter((l: string) => l.trim().length > 0)
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("Database schema is up to date")) {
        console.log(chalk.green(`    ${trimmed}`))
      } else if (trimmed.includes("migration") || trimmed.includes("Following")) {
        console.log(chalk.white(`    ${trimmed}`))
      } else if (trimmed.includes("not yet been applied")) {
        console.log(chalk.yellow(`    ${trimmed}`))
      } else if (trimmed.includes("applied")) {
        console.log(chalk.green(`    ${trimmed}`))
      }
    }

    if (result.exitCode !== 0 && lines.length === 0) {
      console.log(chalk.yellow("    Pending migrations — run: ibx db migrate:domain"))
    }
  } catch {
    console.log(chalk.yellow("    Cannot determine Prisma migration status"))
  }

  // ── Table counts ──────────────────────────────────────────────────────────
  console.log()
  step("Domain table counts")
  try {
    const { prisma } = await import("@ibatexas/domain")

    const counts = await Promise.all([
      prisma.customer.count().then((n: number) => ({ table: "Customer", count: n })),
      prisma.table.count().then((n: number) => ({ table: "Table", count: n })),
      prisma.timeSlot.count().then((n: number) => ({ table: "TimeSlot", count: n })),
      prisma.reservation.count().then((n: number) => ({ table: "Reservation", count: n })),
      prisma.deliveryZone.count().then((n: number) => ({ table: "DeliveryZone", count: n })),
      prisma.customerOrderItem.count().then((n: number) => ({ table: "CustomerOrderItem", count: n })),
      prisma.address.count().then((n: number) => ({ table: "Address", count: n })),
      prisma.customerPreferences.count().then((n: number) => ({ table: "CustomerPreferences", count: n })),
    ])

    for (const { table, count } of counts) {
      const color = count > 0 ? chalk.green : chalk.yellow
      console.log(`    ${table.padEnd(22)} ${color(String(count))}`)
    }

    await prisma.$disconnect()
  } catch (err) {
    console.log(chalk.yellow(`    Cannot query domain tables: ${(err as Error).message}`))
  }

  console.log()
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

  db.command("seed:homepage")
    .description("Seed customers and reviews for homepage sections (Medusa must be running)")
    .action(runSeedHomepage)

  db.command("seed:delivery")
    .description("Seed delivery zones, customer addresses, and dietary preferences")
    .action(runSeedDelivery)

  db.command("seed:orders")
    .description("Seed order history + reservations for intelligence features (Medusa must be running)")
    .action(runSeedOrders)

  db.command("clean")
    .description("⚠️  Delete all domain data (--all to also clean Medusa + Typesense)")
    .option("-f, --force", "Skip the confirmation prompt")
    .option("-a, --all", "Also delete Medusa products, Typesense index, and Redis cache")
    .action((opts: { force?: boolean; all?: boolean }) => runClean(opts))

  db.command("reset")
    .description("⚠️  Drop + migrate (Medusa + domain) + reseed (destructive)")
    .option("-f, --force", "Skip the confirmation prompt")
    .action((opts: { force?: boolean }) => runReset(opts.force))

  db.command("reindex")
    .description("Fetch all products from Medusa and reindex into Typesense")
    .option("--fresh", "Drop and recreate the Typesense collection before indexing")
    .action((opts: { fresh?: boolean }) => runReindex(opts.fresh))

  db.command("status")
    .description("Show migration status for Medusa and domain (Prisma) schemas")
    .action(runStatus)

  return { runMigrate, runMigrateDomain, runSeed, runSeedDomain, runSeedHomepage, runSeedDelivery, runSeedOrders, runClean, runReset, runReindex }
}
