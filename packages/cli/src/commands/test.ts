// ibx test — composite testing commands for seed, integration, e2e, and status.
// Uses the pipeline runner for per-step timing, --from, --skip support.

import type { Command } from "commander"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"
import { runPipeline, guardDestructive, type PipelineTask } from "../lib/pipeline.js"
import { getMedusaUrl, getAdminToken } from "../lib/medusa.js"
import { rk } from "../lib/redis.js"
import { StepRegistry, type StepName } from "../lib/steps.js"

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

async function runStatusChecks(): Promise<StatusCheck[]> {
  const checks: StatusCheck[] = []

  // Products (Typesense)
  try {
    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    const info = await ts.collections(COLLECTION).retrieve()
    const count = info.num_documents ?? 0
    checks.push({
      section: "Products (Typesense)",
      status: count > 0 ? "ok" : "empty",
      count: String(count),
      details: `${count} products indexed`,
    })
  } catch {
    checks.push({
      section: "Products (Typesense)",
      status: "warn",
      count: "?",
      details: "Typesense unavailable",
    })
  }

  // Reviews
  try {
    const { prisma } = await import("@ibatexas/domain")
    const reviewCount = await prisma.review.count()
    const avgResult = await prisma.review.aggregate({ _avg: { rating: true } })
    const avg = avgResult._avg.rating?.toFixed(1) ?? "0"
    checks.push({
      section: "Reviews",
      status: reviewCount >= 5 ? "ok" : reviewCount > 0 ? "warn" : "empty",
      count: String(reviewCount),
      details: `${reviewCount} reviews, avg ${avg}★`,
    })
  } catch {
    checks.push({ section: "Reviews", status: "warn", count: "?", details: "DB unavailable" })
  }

  // Recommendations (global scores)
  try {
    const { getRedisClient, closeRedisClient } = await import("@ibatexas/tools")
    const redis = await getRedisClient()
    const key = rk("product:global:score")
    const count = await redis.zCard(key)
    checks.push({
      section: "Recommendations",
      status: count > 0 ? "ok" : "empty",
      count: count > 0 ? "Ready" : "Empty",
      details: `${count} products in global scores`,
    })
    await closeRedisClient()
  } catch {
    checks.push({ section: "Recommendations", status: "warn", count: "?", details: "Redis unavailable" })
  }

  // Co-purchase (EXISTS check on a known key pattern)
  try {
    const { getRedisClient, closeRedisClient } = await import("@ibatexas/tools")
    const redis = await getRedisClient()
    // Use SCAN with COUNT 1 just to check existence
    const result = await redis.scan(0, { MATCH: rk("copurchase:*"), COUNT: 1 })
    const hasKeys = result.keys.length > 0
    checks.push({
      section: "Co-purchase",
      status: hasKeys ? "ok" : "empty",
      count: hasKeys ? "Ready" : "Empty",
      details: hasKeys ? "Co-purchase data indexed" : "No co-purchase data",
    })
    await closeRedisClient()
  } catch {
    checks.push({ section: "Co-purchase", status: "warn", count: "?", details: "Redis unavailable" })
  }

  // Tags — chef_choice + popular
  try {
    const token = await getAdminToken()
    const base = getMedusaUrl()
    const res = await fetch(`${base}/admin/products?limit=100&fields=id,*tags`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const data = (await res.json()) as { products?: Array<{ tags?: Array<{ value: string }> }> }
      const products = data.products ?? []
      const chefCount = products.filter(
        (p) => p.tags?.some((t) => t.value === "chef_choice"),
      ).length
      const popularCount = products.filter(
        (p) => p.tags?.some((t) => t.value === "popular"),
      ).length
      checks.push({
        section: "PitmasterPick",
        status: chefCount > 0 ? "ok" : "empty",
        count: chefCount > 0 ? "Ready" : "Empty",
        details: `${chefCount} products with chef_choice`,
      })
      checks.push({
        section: "Em Alta",
        status: popularCount > 0 ? "ok" : "empty",
        count: popularCount > 0 ? "Ready" : "Empty",
        details: `${popularCount} products with popular`,
      })
    }
  } catch {
    checks.push({ section: "Tags", status: "warn", count: "?", details: "Medusa unavailable" })
  }

  // Reservations
  try {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.reservation.count()
    checks.push({
      section: "Reservations",
      status: count > 0 ? "ok" : "empty",
      count: String(count),
      details: `${count} reservations`,
    })
  } catch {
    checks.push({ section: "Reservations", status: "warn", count: "?", details: "DB unavailable" })
  }

  // Delivery Zones
  try {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.deliveryZone.count({ where: { active: true } })
    checks.push({
      section: "Delivery Zones",
      status: count > 0 ? "ok" : "empty",
      count: String(count),
      details: `${count} zones active`,
    })
  } catch {
    checks.push({ section: "Delivery Zones", status: "warn", count: "?", details: "DB unavailable" })
  }

  // Tables + TimeSlots
  try {
    const { prisma } = await import("@ibatexas/domain")
    const tableCount = await prisma.table.count()
    const slotCount = await prisma.timeSlot.count()
    const capacityResult = await prisma.table.aggregate({ _sum: { capacity: true } })
    const covers = capacityResult._sum.capacity ?? 0
    checks.push({
      section: "Tables",
      status: tableCount > 0 ? "ok" : "empty",
      count: String(tableCount),
      details: `${tableCount} tables, ${covers} covers, ${slotCount} slots`,
    })
  } catch {
    checks.push({ section: "Tables", status: "warn", count: "?", details: "DB unavailable" })
  }

  // Customers
  try {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.customer.count()
    checks.push({
      section: "Customers",
      status: count > 0 ? "ok" : "empty",
      count: String(count),
      details: `${count} customers seeded`,
    })
  } catch {
    checks.push({ section: "Customers", status: "warn", count: "?", details: "DB unavailable" })
  }

  return checks
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
      const cleanSpinner = ora({ text: "Cleaning…", prefixText: "  " }).start()
      try {
        const { prisma } = await import("@ibatexas/domain")

        // Domain tables (FK-safe order)
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
      } catch (err) {
        cleanSpinner.fail(chalk.red(`Clean failed: ${(err as Error).message}`))
        process.exitCode = 1
        return
      }

      // Step 2: Full seed pipeline
      console.log(chalk.bold("\n  Step 2: Full seed pipeline\n"))
      const tasks = buildSeedPipeline()
      const result = await runPipeline(tasks)

      if (!result.ok) process.exitCode = 1
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

        const sectionW = 24
        const statusW = 10
        const countW = 8

        console.log(chalk.bold("\n  ibx test status\n"))
        console.log(
          `  ${chalk.bold("Section".padEnd(sectionW))}${chalk.bold("Status".padEnd(statusW))}${chalk.bold("Details")}`
        )
        console.log(`  ${"─".repeat(sectionW + statusW + 30)}`)

        let allOk = true
        for (const check of checks) {
          const icon =
            check.status === "ok" ? chalk.green("✅") :
            check.status === "warn" ? chalk.yellow("⚠️ ") :
            chalk.gray("○ ")
          const countStr =
            check.status === "ok" ? chalk.green(check.count.padEnd(countW)) :
            check.status === "warn" ? chalk.yellow(check.count.padEnd(countW)) :
            chalk.gray(check.count.padEnd(countW))

          console.log(
            `  ${check.section.padEnd(sectionW)}${icon} ${countStr} ${chalk.dim(check.details)}`
          )

          if (check.status !== "ok") allOk = false
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        console.log(`  ${"─".repeat(sectionW + statusW + 30)}`)

        if (allOk) {
          console.log(chalk.green(`\n  Total: ready for testing ✅`))
        } else {
          console.log(chalk.yellow(`\n  Some sections need seeding. Run: ibx test seed`))
        }
        console.log(chalk.dim(`\n  Ran in ${elapsed}s\n`))
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
