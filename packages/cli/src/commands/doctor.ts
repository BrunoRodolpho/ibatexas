// ibx doctor — comprehensive system health check.
// CI gate command that runs all validations.
// --fix: attempt auto-fixes (reindex, rebuild intel)
// --ci: exit code 1 on any failure

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

import { rk, getRedis, closeRedis, scanCount } from "../lib/redis.js"
import { fetchAllProductsWithTags } from "../lib/medusa.js"
import { StepRegistry } from "../lib/steps.js"

// ── Types ────────────────────────────────────────────────────────────────────

interface DiagResult {
  section: string
  check: string
  status: "ok" | "warn" | "error"
  detail: string
}

// ── Auto-fix helpers ────────────────────────────────────────────────────────

async function autoFixReindex(): Promise<void> {
  const spinner = ora("  Reindexing Typesense…").start()
  try {
    await StepRegistry["reindex"].run()
    spinner.succeed(chalk.green("  Reindexed Typesense"))
  } catch (err) {
    spinner.fail(chalk.red(`  Reindex failed: ${(err as Error).message}`))
  }
}

async function autoFixIntelligence(): Promise<void> {
  const spinner = ora("  Rebuilding intelligence…").start()
  try {
    await StepRegistry["intel-copurchase"].run()
    await StepRegistry["intel-global-score"].run()
    spinner.succeed(chalk.green("  Intelligence rebuilt"))
  } catch (err) {
    spinner.fail(chalk.red(`  Intel rebuild failed: ${(err as Error).message}`))
  }
}

async function autoFixReviewSync(): Promise<void> {
  const spinner = ora("  Syncing review stats…").start()
  try {
    await StepRegistry["sync-reviews"].run()
    spinner.succeed(chalk.green("  Review stats synced"))
  } catch (err) {
    spinner.fail(chalk.red(`  Sync failed: ${(err as Error).message}`))
  }
}

async function runAutoFixes(results: DiagResult[], needsIntelRebuild: boolean): Promise<void> {
  console.log(chalk.bold("\n  Auto-fix"))

  const productMismatch = results.find((r) => r.check === "Products" && r.status !== "ok")
  if (productMismatch) {
    await autoFixReindex()
  }

  if (needsIntelRebuild) {
    await autoFixIntelligence()
  }

  const reviewWarn = results.find((r) => r.check === "Reviews" && r.status !== "ok")
  if (reviewWarn) {
    await autoFixReviewSync()
  }
}

// ── Summary printer ─────────────────────────────────────────────────────────

function printDiagSummary(results: DiagResult[], elapsed: string): void {
  const errors = results.filter((r) => r.status === "error")
  const warns = results.filter((r) => r.status === "warn")

  console.log()
  if (errors.length === 0 && warns.length === 0) {
    console.log(chalk.green(`  System Healthy ✅ (${elapsed}s)\n`))
  } else if (errors.length === 0) {
    console.log(chalk.yellow(`  System OK with ${warns.length} warning(s) (${elapsed}s)\n`))
  } else {
    console.log(chalk.red(`  ${errors.length} error(s), ${warns.length} warning(s) (${elapsed}s)\n`))
  }
}

// ── Disconnect helper ───────────────────────────────────────────────────────

async function disconnectAll(): Promise<void> {
  try { await closeRedis() } catch { /* best effort */ }
  try {
    const { prisma } = await import("@ibatexas/domain")
    await prisma.$disconnect()
  } catch { /* best effort */ }
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function registerDoctorCommands(program: Command): void {
  program
    .description("System diagnostics — full health check (--fix to auto-repair, --ci for exit codes)")
    .option("--fix", "Attempt auto-fixes (reindex, sync-reviews, rebuild intel)")
    .option("--ci", "Exit code 1 on any error-severity failure")
    .action(async (opts: { fix?: boolean; ci?: boolean }) => {
      const start = Date.now()
      const results: DiagResult[] = []

      console.log(chalk.bold("\n  IBX System Diagnostics\n"))

      // ── 1. Infrastructure ─────────────────────────────────────────────
      console.log(chalk.bold("  Infrastructure"))
      await runInfraCheck(results, "Postgres", checkPostgresHealth)
      await runInfraCheck(results, "Redis", checkRedisHealth)
      await runInfraCheck(results, "Typesense", checkTypesenseHealth)

      // ── 2. Data Integrity ─────────────────────────────────────────────
      console.log(chalk.bold("\n  Data Integrity"))
      await runInfraCheck(results, "Products", checkProductsIntegrity)
      await runInfraCheck(results, "Reviews", checkReviewsIntegrity)
      await runInfraCheck(results, "Order Items", checkOrderItemsIntegrity)

      // ── 3. Intelligence ───────────────────────────────────────────────
      console.log(chalk.bold("\n  Intelligence"))
      let needsIntelRebuild = false

      await runInfraCheck(results, "Global Scores", async () => {
        try {
          const redis = await getRedis()
          const count = await redis.zCard(rk("product:global:score"))
          if (count === 0) needsIntelRebuild = true
          return { status: count > 0 ? "ok" : "warn", detail: `${count} products scored` }
        } catch {
          return { status: "warn", detail: "Redis unavailable" }
        }
      })
      await runInfraCheck(results, "Copurchase", async () => {
        try {
          const redis = await getRedis()
          const count = await scanCount(redis, rk("copurchase:*"))
          if (count === 0) needsIntelRebuild = true
          return { status: count > 0 ? "ok" : "warn", detail: `${count} relations` }
        } catch {
          return { status: "warn", detail: "Redis unavailable" }
        }
      })

      // ── 4. UI Contracts ───────────────────────────────────────────────
      console.log(chalk.bold("\n  UI Contracts"))
      await runInfraCheck(results, "Popular Tags", () => checkTagCount("popular"))
      await runInfraCheck(results, "Chef Choice Tags", () => checkTagCount("chef_choice"))

      // ── Auto-fix ──────────────────────────────────────────────────────
      if (opts.fix) {
        await runAutoFixes(results, needsIntelRebuild)
      }

      // ── Summary ───────────────────────────────────────────────────────
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      printDiagSummary(results, elapsed)

      await disconnectAll()

      if (opts.ci && results.filter((r) => r.status === "error").length > 0) {
        process.exitCode = 1
      }
    })
}

// ── Check functions ─────────────────────────────────────────────────────────

async function checkPostgresHealth(): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const { prisma } = await import("@ibatexas/domain")
    await prisma.$queryRaw`SELECT 1`
    await prisma.$disconnect()
    return { status: "ok", detail: "connected (5433)" }
  } catch {
    return { status: "error", detail: "connection failed" }
  }
}

async function checkRedisHealth(): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const redis = await getRedis()
    await redis.ping()
    return { status: "ok", detail: "connected (6379)" }
  } catch {
    return { status: "error", detail: "connection failed" }
  }
}

async function checkTypesenseHealth(): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    await ts.collections(COLLECTION).retrieve()
    return { status: "ok", detail: "connected (8108)" }
  } catch {
    return { status: "error", detail: "connection failed" }
  }
}

async function checkProductsIntegrity(): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const products = await fetchAllProductsWithTags()
    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    const info = await ts.collections(COLLECTION).retrieve()
    const tsCount = info.num_documents ?? 0

    if (products.length === tsCount) {
      return { status: "ok", detail: `Medusa ${products.length} = Typesense ${tsCount}` }
    }
    return { status: "warn", detail: `Medusa ${products.length} ≠ Typesense ${tsCount}` }
  } catch (err) {
    return { status: "warn", detail: (err as Error).message }
  }
}

async function checkReviewsIntegrity(): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.review.count()
    await prisma.$disconnect()
    return { status: count > 0 ? "ok" : "warn", detail: `${count} reviews` }
  } catch {
    return { status: "warn", detail: "DB unavailable" }
  }
}

async function checkOrderItemsIntegrity(): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.customerOrderItem.count()
    await prisma.$disconnect()
    return { status: count > 0 ? "ok" : "warn", detail: `${count} items` }
  } catch {
    return { status: "warn", detail: "DB unavailable" }
  }
}

async function checkTagCount(tagValue: string): Promise<{ status: "ok" | "warn" | "error"; detail: string }> {
  try {
    const products = await fetchAllProductsWithTags()
    const count = products.filter((p) => p.tags?.some((t) => t.value === tagValue)).length
    return { status: count > 0 ? "ok" : "warn", detail: `${count} products tagged ${tagValue}` }
  } catch {
    return { status: "warn", detail: "Medusa unavailable" }
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function runInfraCheck(
  results: DiagResult[],
  check: string,
  fn: () => Promise<{ status: "ok" | "warn" | "error"; detail: string }>,
): Promise<void> {
  try {
    const result = await fn()
    results.push({ section: "check", check, ...result })

    const icon =
      result.status === "ok" ? chalk.green("✅") :
      result.status === "warn" ? chalk.yellow("⚠️ ") :
      chalk.red("❌")
    console.log(`    ${icon} ${check.padEnd(20)} ${chalk.dim(result.detail)}`)
  } catch (err) {
    results.push({ section: "check", check, status: "error", detail: (err as Error).message })
    console.log(`    ${chalk.red("❌")} ${check.padEnd(20)} ${chalk.dim((err as Error).message)}`)
  }
}
