// ibx test — composite testing commands for seed, integration, e2e, and status.
// Uses the pipeline runner for per-step timing, --from, --skip support.

import type { Command } from "commander"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import { runPipeline, guardDestructive, type PipelineTask } from "../lib/pipeline.js"
import { getMedusaUrl, getAdminToken } from "../lib/medusa.js"
import { rk } from "../lib/redis.js"
import { StepRegistry, type StepName } from "../lib/steps.js"
import { cleanDomainTables } from "../lib/clean.js"
import { ROOT } from "../utils/root.js"

// ── Pipeline task builders ──────────────────────────────────────────────────

function buildSeedPipeline(): PipelineTask[] {
  const stepOrder: StepName[] = [
    "seed-products",
    "reindex",
    "seed-domain",
    "seed-homepage",
    "seed-delivery",
    "seed-orders",
    "sync-reviews",
    "intel-copurchase",
    "intel-global-score",
  ]

  return stepOrder.map((name) => ({
    name,
    label: StepRegistry[name].label,
    run: StepRegistry[name].run,
  }))
}

// ── Status checks ───────────────────────────────────────────────────────────

interface StatusCheck {
  section: string
  status: "ok" | "warn" | "empty"
  count: string
  details: string
}

/** Run a single status check, catching errors and returning a warn result on failure. */
async function safeCheck(
  section: string,
  failDetail: string,
  fn: () => Promise<StatusCheck | StatusCheck[]>,
): Promise<StatusCheck[]> {
  try {
    const result = await fn()
    return Array.isArray(result) ? result : [result]
  } catch {
    return [{ section, status: "warn", count: "?", details: failDetail }]
  }
}

/** Count-based status: ok if count > 0, else empty. */
function countStatus(section: string, count: number, details: string): StatusCheck {
  return {
    section,
    status: count > 0 ? "ok" : "empty",
    count: String(count),
    details,
  }
}

/** Ready/Empty status based on a boolean flag. */
function readyStatus(section: string, ready: boolean, details: string): StatusCheck {
  return {
    section,
    status: ready ? "ok" : "empty",
    count: ready ? "Ready" : "Empty",
    details,
  }
}

async function checkTypesense(): Promise<StatusCheck> {
  const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
  const ts = getTypesenseClient()
  const info = await ts.collections(COLLECTION).retrieve()
  const count = info.num_documents ?? 0
  return countStatus("Products (Typesense)", count, `${count} products indexed`)
}

async function checkReviews(): Promise<StatusCheck> {
  const { prisma } = await import("@ibatexas/domain")
  const reviewCount = await prisma.review.count()
  const avgResult = await prisma.review.aggregate({ _avg: { rating: true } })
  const avg = avgResult._avg.rating?.toFixed(1) ?? "0"
  let reviewStatus: "ok" | "warn" | "empty"
  if (reviewCount >= 5) reviewStatus = "ok"
  else if (reviewCount > 0) reviewStatus = "warn"
  else reviewStatus = "empty"
  return {
    section: "Reviews",
    status: reviewStatus,
    count: String(reviewCount),
    details: `${reviewCount} reviews, avg ${avg}★`,
  }
}

async function checkRecommendations(): Promise<StatusCheck> {
  const { getRedisClient, closeRedisClient } = await import("@ibatexas/tools")
  const redis = await getRedisClient()
  const key = rk("product:global:score")
  const count = await redis.zCard(key)
  await closeRedisClient()
  return readyStatus("Recommendations", count > 0, `${count} products in global scores`)
}

async function checkCopurchase(): Promise<StatusCheck> {
  const { getRedisClient, closeRedisClient } = await import("@ibatexas/tools")
  const redis = await getRedisClient()
  const result = await redis.scan(0, { MATCH: rk("copurchase:*"), COUNT: 1 })
  const hasKeys = result.keys.length > 0
  await closeRedisClient()
  return readyStatus("Co-purchase", hasKeys, hasKeys ? "Co-purchase data indexed" : "No co-purchase data")
}

async function checkTags(): Promise<StatusCheck[]> {
  const token = await getAdminToken()
  const base = getMedusaUrl()
  const res = await fetch(`${base}/admin/products?limit=100&fields=id,*tags`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return []
  const data = (await res.json()) as { products?: Array<{ tags?: Array<{ value: string }> }> }
  const products = data.products ?? []
  const chefCount = products.filter((p) => p.tags?.some((t) => t.value === "chef_choice")).length
  const popularCount = products.filter((p) => p.tags?.some((t) => t.value === "popular")).length
  return [
    readyStatus("PitmasterPick", chefCount > 0, `${chefCount} products with chef_choice`),
    readyStatus("Em Alta", popularCount > 0, `${popularCount} products with popular`),
  ]
}

async function checkTables(): Promise<StatusCheck> {
  const { prisma } = await import("@ibatexas/domain")
  const tableCount = await prisma.table.count()
  const slotCount = await prisma.timeSlot.count()
  const capacityResult = await prisma.table.aggregate({ _sum: { capacity: true } })
  const covers = capacityResult._sum.capacity ?? 0
  return countStatus("Tables", tableCount, `${tableCount} tables, ${covers} covers, ${slotCount} slots`)
}

async function checkPrismaCount(
  section: string,
  detail: (n: number) => string,
  query: () => Promise<number>,
): Promise<StatusCheck> {
  const count = await query()
  return countStatus(section, count, detail(count))
}

async function runStatusChecks(): Promise<StatusCheck[]> {
  const { prisma } = await import("@ibatexas/domain")

  const groups = await Promise.all([
    safeCheck("Products (Typesense)", "Typesense unavailable", checkTypesense),
    safeCheck("Reviews", "DB unavailable", checkReviews),
    safeCheck("Recommendations", "Redis unavailable", checkRecommendations),
    safeCheck("Co-purchase", "Redis unavailable", checkCopurchase),
    safeCheck("Tags", "Medusa unavailable", checkTags),
    safeCheck("Reservations", "DB unavailable", () =>
      checkPrismaCount("Reservations", (n) => `${n} reservations`, () => prisma.reservation.count()),
    ),
    safeCheck("Delivery Zones", "DB unavailable", () =>
      checkPrismaCount("Delivery Zones", (n) => `${n} zones active`, () => prisma.deliveryZone.count({ where: { active: true } })),
    ),
    safeCheck("Tables", "DB unavailable", checkTables),
    safeCheck("Customers", "DB unavailable", () =>
      checkPrismaCount("Customers", (n) => `${n} customers seeded`, () => prisma.customer.count()),
    ),
  ])

  return groups.flat()
}

// ── E2E clean ──────────────────────────────────────────────────────────────

async function cleanAllData(): Promise<boolean> {
  const cleanSpinner = ora({ text: "Cleaning…", prefixText: "  " }).start()
  try {
    const { prisma } = await import("@ibatexas/domain")

    // Domain tables (FK-safe order)
    await cleanDomainTables(prisma)

    cleanSpinner.text = "Clearing Typesense…"
    try {
      const { recreateCollection } = await import("@ibatexas/tools")
      await recreateCollection()
    } catch {
      // Typesense might not be running
    }

    cleanSpinner.text = "Clearing Redis cache…"
    try {
      const { invalidateAllQueryCache, closeRedisClient } = await import("@ibatexas/tools")
      await invalidateAllQueryCache()
      await closeRedisClient()
    } catch {
      // Redis might not be running
    }

    cleanSpinner.succeed(chalk.green("All data cleaned"))
    return true
  } catch (err) {
    cleanSpinner.fail(chalk.red(`Clean failed: ${(err as Error).message}`))
    return false
  }
}

// ── Status table renderer ──────────────────────────────────────────────────

function printStatusTable(checks: StatusCheck[], elapsed: string): void {
  const sectionW = 24
  const statusW = 10

  console.log(chalk.bold("\n  ibx test status\n"))
  console.log(
    `  ${chalk.bold("Section".padEnd(sectionW))}${chalk.bold("Status".padEnd(statusW))}${chalk.bold("Details")}`
  )
  console.log(`  ${"─".repeat(sectionW + statusW + 30)}`)

  const countW = 8
  let allOk = true
  for (const check of checks) {
    let icon: string
    if (check.status === "ok") icon = chalk.green("✅")
    else if (check.status === "warn") icon = chalk.yellow("⚠️ ")
    else icon = chalk.gray("○ ")

    let countStr: string
    if (check.status === "ok") countStr = chalk.green(check.count.padEnd(countW))
    else if (check.status === "warn") countStr = chalk.yellow(check.count.padEnd(countW))
    else countStr = chalk.gray(check.count.padEnd(countW))

    console.log(
      `  ${check.section.padEnd(sectionW)}${icon} ${countStr} ${chalk.dim(check.details)}`
    )

    if (check.status !== "ok") allOk = false
  }

  console.log(`  ${"─".repeat(sectionW + statusW + 30)}`)

  if (allOk) {
    console.log(chalk.green(`\n  Total: ready for testing ✅`))
  } else {
    console.log(chalk.yellow(`\n  Some sections need seeding. Run: ibx test seed`))
  }
  console.log(chalk.dim(`\n  Ran in ${elapsed}s\n`))
}

// ── Command registration ────────────────────────────────────────────────────

export function registerTestCommands(group: Command): void {
  group.description("Testing — composite seed, integration, e2e, and status commands")

  // ─── test seed ──────────────────────────────────────────────────────────
  group
    .command("seed")
    .description("Run the full seed pipeline: products → reindex → domain → homepage → delivery → orders → reviews → intel")
    .option("--from <task>", "Start from a specific task (skip earlier ones)")
    .option("--skip <patterns>", "Skip tasks matching pattern(s), comma-separated")
    .option("--dry-run", "Print the pipeline without executing")
    .action(async (opts: { from?: string; skip?: string; dryRun?: boolean }) => {
      const tasks = buildSeedPipeline()
      const result = await runPipeline(tasks, {
        from: opts.from,
        skip: opts.skip?.split(","),
        dryRun: opts.dryRun,
      })

      if (!result.ok) process.exitCode = 1
    })

  // ─── test integration ───────────────────────────────────────────────────
  group
    .command("integration")
    .description("Seed for UI ↔ API testing — skips product seed if products already exist")
    .option("--from <task>", "Start from a specific task")
    .option("--skip <patterns>", "Skip tasks matching pattern(s), comma-separated")
    .action(async (opts: { from?: string; skip?: string }) => {
      // Pre-flight: check if products already exist
      let skipProducts = false
      try {
        const token = await getAdminToken()
        const base = getMedusaUrl()
        const res = await fetch(`${base}/admin/products?limit=1&fields=id`, {
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = (await res.json()) as { products?: unknown[] }
          if ((data.products ?? []).length > 0) {
            skipProducts = true
            console.log(chalk.dim("  Products already exist in Medusa — skipping seed-products"))
          }
        }
      } catch {
        // If we can't check, run the full pipeline
      }

      const skipPatterns = opts.skip?.split(",") ?? []
      if (skipProducts) skipPatterns.push("seed-products")

      const tasks = buildSeedPipeline()
      const result = await runPipeline(tasks, {
        from: opts.from,
        skip: skipPatterns.length > 0 ? skipPatterns : undefined,
      })

      if (!result.ok) process.exitCode = 1
    })

  // ─── test e2e ───────────────────────────────────────────────────────────
  group
    .command("e2e")
    .description("⚠️  Full clean + seed (destructive) — requires --force or confirmation")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (opts: { force?: boolean }) => {
      guardDestructive("test e2e")

      if (!opts.force) {
        const confirmed = await confirm({
          message: chalk.yellow(
            "⚠️  This will DELETE all data and reseed from scratch. Continue?",
          ),
          default: false,
        })
        if (!confirmed) {
          console.log(chalk.gray("Aborted."))
          return
        }
      }

      // Step 1: Clean all data
      console.log(chalk.bold("\n  Step 1: Clean all data\n"))
      const cleanOk = await cleanAllData()
      if (!cleanOk) {
        process.exitCode = 1
        return
      }

      // Step 2: Full seed pipeline
      console.log(chalk.bold("\n  Step 2: Full seed pipeline\n"))
      const tasks = buildSeedPipeline()
      const result = await runPipeline(tasks)

      if (!result.ok) process.exitCode = 1
    })

  // ─── test e2e-run ──────────────────────────────────────────────────────
  group
    .command("e2e-run")
    .description("Run Playwright E2E tests (optionally pass a filter or Playwright flags)")
    .argument("[filter]", "Test file filter or Playwright CLI args")
    .option("--headed", "Run browsers in headed mode")
    .option("--ui", "Open Playwright UI mode")
    .allowUnknownOption(true)
    .action(async (filter: string | undefined, opts: { headed?: boolean; ui?: boolean }, cmd: Command) => {
      const args = ["playwright", "test"]

      if (filter) args.push(filter)
      if (opts.headed) args.push("--headed")
      if (opts.ui) args.push("--ui")

      // Forward any unknown flags to Playwright
      const unknownArgs = cmd.args.filter((a: string) => a !== filter)
      args.push(...unknownArgs)

      console.log(chalk.dim(`  Running: npx ${args.join(" ")}\n`))

      try {
        await execa("npx", args, {
          cwd: ROOT,
          stdio: "inherit",
          env: { ...process.env, FORCE_COLOR: "1" },
        })
      } catch (err) {
        const exitCode = (err as { exitCode?: number }).exitCode ?? 1
        process.exitCode = exitCode
      }
    })

  // ─── test status ────────────────────────────────────────────────────────
  group
    .command("status")
    .description("Check data status across all sections — shows what's seeded and ready")
    .action(async () => {
      const spinner = ora("Checking data status…").start()
      const start = Date.now()

      try {
        const checks = await runStatusChecks()
        spinner.stop()

        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        printStatusTable(checks, elapsed)
      } catch (err) {
        spinner.fail(chalk.red(`Status check failed: ${(err as Error).message}`))
        process.exitCode = 1
      }

      // Disconnect Prisma if imported
      try {
        const { prisma } = await import("@ibatexas/domain")
        await prisma.$disconnect()
      } catch {
        // ignore
      }
    })
}
