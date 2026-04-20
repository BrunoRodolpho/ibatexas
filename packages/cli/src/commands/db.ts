import type { Command } from "commander"
import type { MedusaProductInput } from "@ibatexas/tools"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"
import { guardDestructive } from "../lib/pipeline.js"
import { getMedusaUrl, getAdminToken, medusaFetch } from "../lib/medusa.js"
import { cleanDomainTables } from "../lib/clean.js"

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

async function runMigrateDomain(opts: { name?: string } = {}) {
  const spinner = ora("Running domain (Prisma) migrations…").start()
  try {
    const args = ["--filter", "@ibatexas/domain", "db:migrate"]
    if (opts.name) {
      args.push("--", "--name", opts.name)
    }
    await execa("pnpm", args, {
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
    [...psqlBase, "postgres", "-c", `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`],
    pgEnv
  )

  step("Creating database…")
  await runPsql(
    [...psqlBase, "postgres", "-c", `CREATE DATABASE "${dbName}"`],
    pgEnv
  )

  // Helper: run a step, warn and continue on failure instead of crashing
  const warnings: string[] = []
  async function tryStep(label: string, fn: () => Promise<void>) {
    step(label)
    try {
      await fn()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      const isConnectivity = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|Connection refused/i.test(msg)
      if (isConnectivity) {
        console.log(chalk.yellow(`    ⚠  Skipped (service not reachable). Run this step manually later.`))
      } else {
        console.log(chalk.yellow(`    ⚠  Failed: ${msg}`))
      }
      warnings.push(label)
    }
  }

  // ── Critical steps (must succeed) ──────────────────────────────────────

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

  // ── Seed steps (warn and continue on failure) ──────────────────────────

  await tryStep("Seeding Medusa products…", async () => {
    await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:seed"], {
      cwd: ROOT,
      stdio: "inherit",
    })
  })

  await tryStep("Seeding domain tables…", async () => {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:tables"], {
      cwd: ROOT,
      stdio: "inherit",
    })
  })

  await tryStep("Seeding homepage data (customers + reviews)…", async () => {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:homepage"], {
      cwd: ROOT,
      stdio: "inherit",
    })
  })

  await tryStep("Seeding delivery data (zones + addresses + preferences)…", async () => {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:delivery"], {
      cwd: ROOT,
      stdio: "inherit",
    })
  })

  await tryStep("Seeding order history + reservations…", async () => {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:orders"], {
      cwd: ROOT,
      stdio: "inherit",
    })
  })

  // Belt-and-braces reindex: the Medusa seed now reindexes products with
  // linked prices itself, but a fresh Typesense collection here guarantees
  // we never carry stale docs across resets regardless of what the seed did.
  await tryStep("Reindexing Typesense…", async () => {
    await runReindex(true)
  })

  if (warnings.length > 0) {
    console.log(chalk.yellow(`\n  ⚠  ${warnings.length} step(s) skipped:`))
    for (const w of warnings) {
      console.log(chalk.yellow(`     • ${w}`))
    }
    console.log(chalk.yellow(`     Re-run individually after starting the required services.\n`))
  }

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

    await cleanDomainTables(prisma)

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
    await indexProductsBatch(allProducts as MedusaProductInput[])
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

async function checkMedusaMigrations(): Promise<void> {
  try {
    const result = await execa("pnpm", ["--filter", "@ibatexas/commerce", "exec", "medusa", "db:migrate", "--skip"], {
      cwd: ROOT,
      reject: false,
    })
    if (result.exitCode === 0) {
      console.log(chalk.green("    Migrations up to date"))
    } else {
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
}

function printPrismaStatusLine(trimmed: string): void {
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

async function checkPrismaMigrations(): Promise<void> {
  try {
    const result = await execa(
      "pnpm", ["--filter", "@ibatexas/domain", "exec", "prisma", "migrate", "status"],
      { cwd: ROOT, reject: false }
    )
    const output = `${result.stdout}\n${result.stderr}`.trim()
    const lines = output.split("\n").filter((l: string) => l.trim().length > 0)
    for (const line of lines) {
      printPrismaStatusLine(line.trim())
    }
    if (result.exitCode !== 0 && lines.length === 0) {
      console.log(chalk.yellow("    Pending migrations — run: ibx db migrate:domain"))
    }
  } catch {
    console.log(chalk.yellow("    Cannot determine Prisma migration status"))
  }
}

async function printDomainTableCounts(): Promise<void> {
  try {
    const { prisma } = await import("@ibatexas/domain")

    const tableNames = [
      "Customer", "Table", "TimeSlot", "Reservation",
      "DeliveryZone", "CustomerOrderItem", "Address", "CustomerPreferences",
    ] as const

    const countFns: Record<typeof tableNames[number], () => Promise<number>> = {
      Customer: () => prisma.customer.count(),
      Table: () => prisma.table.count(),
      TimeSlot: () => prisma.timeSlot.count(),
      Reservation: () => prisma.reservation.count(),
      DeliveryZone: () => prisma.deliveryZone.count(),
      CustomerOrderItem: () => prisma.customerOrderItem.count(),
      Address: () => prisma.address.count(),
      CustomerPreferences: () => prisma.customerPreferences.count(),
    }

    const counts = await Promise.all(
      tableNames.map(async (table) => ({ table, count: await countFns[table]() }))
    )

    for (const { table, count } of counts) {
      const color = count > 0 ? chalk.green : chalk.yellow
      console.log(`    ${table.padEnd(22)} ${color(String(count))}`)
    }

    await prisma.$disconnect()
  } catch (err) {
    console.log(chalk.yellow(`    Cannot query domain tables: ${(err as Error).message}`))
  }
}

async function runStatus() {
  console.log(chalk.bold("\n  ibx db status\n"))

  const step = (msg: string) =>
    console.log(chalk.bold(`  ${chalk.cyan("●")} ${msg}\n`))

  step("Medusa (MikroORM)")
  await checkMedusaMigrations()

  console.log()

  step("Domain (Prisma — ibx_domain)")
  await checkPrismaMigrations()

  console.log()
  step("Domain table counts")
  await printDomainTableCounts()

  console.log()
}

// ── Order Projection Backfill ─────────────────────────────────────────────────

async function runBackfillOrderProjections() {
  const spinner = ora("Backfilling order projections from Medusa…").start()
  let backfilled = 0
  let skipped = 0
  const batchId = `backfill-${Date.now()}`

  try {
    const { prisma } = await import("@ibatexas/domain")
    const { toOrderProjectionData } = await import("@ibatexas/domain")
    const PAGE_SIZE = 50
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        fields: "id,display_id,email,total,subtotal,shipping_total,status,payment_status,fulfillment_status,created_at,metadata",
        expand: "items,customer,shipping_address",
      })

      const medusaUrl = getMedusaUrl()
      const token = await getAdminToken()
      const res = await fetch(`${medusaUrl}/admin/orders?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        throw new Error(`Medusa API returned ${res.status}: ${await res.text()}`)
      }

      const data = await res.json() as { orders: Array<Record<string, unknown>>; count: number }
      const orders = data.orders ?? []

      if (orders.length === 0) {
        hasMore = false
        break
      }

      for (const rawOrder of orders) {
        try {
          const projData = toOrderProjectionData(
            rawOrder as unknown as Parameters<typeof toOrderProjectionData>[0],
            { pricesInCentavos: false }, // Medusa returns reais
          )

          // Upsert — skip if version > 1 (already has real transitions)
          const existing = await prisma.orderProjection.findUnique({
            where: { id: projData.id },
            select: { version: true },
          })

          if (existing && existing.version > 1) {
            skipped++
            continue
          }

          await prisma.orderProjection.upsert({
            where: { id: projData.id },
            create: {
              ...projData,
              fulfillmentStatus: projData.fulfillmentStatus as "pending" | "confirmed" | "preparing" | "ready" | "in_delivery" | "delivered" | "canceled",
              itemsJson: projData.itemsJson as unknown as object,
              shippingAddressJson: projData.shippingAddressJson ?? undefined,
              version: 1,
            },
            update: {}, // no-op if exists with version 1
          })

          // Create initial status history entry (only if projection was just created)
          if (!existing) {
            const status = projData.fulfillmentStatus as "pending" | "confirmed" | "preparing" | "ready" | "in_delivery" | "delivered" | "canceled"
            await prisma.orderStatusHistory.create({
              data: {
                orderId: projData.id,
                fromStatus: status,
                toStatus: status,
                actor: "system_backfill",
                reason: "Historical backfill",
                version: 1,
                backfillBatchId: batchId,
              },
            })
          }

          backfilled++
        } catch (orderErr) {
          // Skip individual order errors (e.g. duplicate key race)
          if (!String(orderErr).includes("Unique constraint")) {
            spinner.warn(`Order ${(rawOrder as { id?: string }).id}: ${String(orderErr)}`)
          }
          skipped++
        }
      }

      spinner.text = `Backfilling order projections… (${backfilled} created, ${skipped} skipped, offset ${offset})`
      offset += PAGE_SIZE

      if (orders.length < PAGE_SIZE) {
        hasMore = false
      }
    }

    await prisma.$disconnect()
    spinner.succeed(`Order projections backfilled: ${backfilled} created, ${skipped} skipped (batch: ${batchId})`)
  } catch (err) {
    spinner.fail(`Backfill failed: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

// ── Payment Backfill ────────────────────────────────────────────────────────

/**
 * Maps legacy Medusa payment_status strings to PaymentStatus enum values.
 * Medusa uses: "captured", "awaiting", "not_paid", "requires_action", "canceled", "refunded"
 */
function mapLegacyPaymentStatus(medusaStatus: string | null | undefined): string {
  switch (medusaStatus) {
    case "captured": return "paid"
    case "awaiting": return "awaiting_payment"
    case "not_paid": return "awaiting_payment"
    case "requires_action": return "payment_pending"
    case "canceled": return "canceled"
    case "refunded": return "refunded"
    default: return "awaiting_payment"
  }
}

async function runBackfillPayments() {
  const spinner = ora("Backfilling payment rows from order projections…").start()
  let created = 0
  let skipped = 0

  try {
    const { prisma } = await import("@ibatexas/domain")
    const PAGE_SIZE = 50
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const orders = await prisma.orderProjection.findMany({
        where: { currentPaymentId: null },
        select: {
          id: true,
          paymentStatus: true,
          paymentMethod: true,
          totalInCentavos: true,
        },
        take: PAGE_SIZE,
        skip: offset,
        orderBy: { createdAt: "asc" },
      })

      if (orders.length === 0) {
        hasMore = false
        break
      }

      for (const order of orders) {
        try {
          const method = (order.paymentMethod ?? "pix") as "pix" | "card" | "cash"
          const mappedStatus = mapLegacyPaymentStatus(order.paymentStatus)

          // Determine initial status based on method (same as PaymentCommandService.create)
          const initialStatus = method === "cash" ? "cash_pending" : "awaiting_payment"

          // Create Payment row in a transaction
          await prisma.$transaction(async (tx) => {
            // Double-check no active payment exists (race guard)
            const existing = await tx.payment.findFirst({
              where: {
                orderId: order.id,
                status: {
                  notIn: ["refunded", "canceled", "waived", "payment_failed", "payment_expired"],
                },
              },
              select: { id: true },
            })

            if (existing) {
              skipped++
              return
            }

            const payment = await tx.payment.create({
              data: {
                orderId: order.id,
                method,
                status: mappedStatus as "awaiting_payment" | "payment_pending" | "paid" | "cash_pending" | "canceled" | "refunded",
                amountInCentavos: order.totalInCentavos,
                version: 1,
              },
            })

            // Record initial history
            await tx.paymentStatusHistory.create({
              data: {
                paymentId: payment.id,
                fromStatus: initialStatus as "awaiting_payment" | "cash_pending",
                toStatus: mappedStatus as "awaiting_payment" | "payment_pending" | "paid" | "cash_pending" | "canceled" | "refunded",
                actor: "system_backfill",
                reason: "Historical backfill from OrderProjection",
                version: 1,
              },
            })

            // Link payment to order
            await tx.orderProjection.update({
              where: { id: order.id },
              data: { currentPaymentId: payment.id },
            })

            created++
          })
        } catch (orderErr) {
          if (!String(orderErr).includes("Unique constraint")) {
            spinner.warn(`Order ${order.id}: ${String(orderErr)}`)
          }
          skipped++
        }
      }

      spinner.text = `Backfilling payments… (${created} created, ${skipped} skipped, offset ${offset})`
      offset += PAGE_SIZE

      if (orders.length < PAGE_SIZE) {
        hasMore = false
      }
    }

    await prisma.$disconnect()
    spinner.succeed(`Payment rows backfilled: ${created} created, ${skipped} skipped`)
  } catch (err) {
    spinner.fail(`Payment backfill failed: ${(err as Error).message}`)
    process.exitCode = 1
  }
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
    .option("--name <name>", "Migration name (e.g. add_order_event_log)")
    .action((opts: { name?: string }) => runMigrateDomain(opts))

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

  db.command("seed:order-projections")
    .description("Backfill order projections from Medusa orders (idempotent, safe to re-run)")
    .action(runBackfillOrderProjections)

  db.command("seed:payment-projections")
    .description("Backfill payment rows from order projections (idempotent, safe to re-run)")
    .action(runBackfillPayments)

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

  return { runMigrate, runMigrateDomain, runSeed, runSeedDomain, runSeedHomepage, runSeedDelivery, runSeedOrders, runBackfillOrderProjections, runClean, runReset, runReindex }
}
