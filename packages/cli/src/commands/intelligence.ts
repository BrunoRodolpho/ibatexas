import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

import { rk, getRedis, closeRedis, scanDelete } from "../lib/redis.js"

// ── Commands ──────────────────────────────────────────────────────────────────

export function registerIntelligenceCommands(program: Command): void {
  const intel = program
    .command("intelligence")
    .alias("intel")
    .description("Customer intelligence — co-purchase and scoring utilities")

  // ─── copurchase-reset ─────────────────────────────────────────────────────
  intel
    .command("copurchase-reset")
    .description("Delete all co-purchase Redis sorted sets (ibatexas.*.copurchase:*)")
    .action(async () => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        spinner.text = "Scanning co-purchase keys…"

        const pattern = rk("copurchase:*")
        const deleted = await scanDelete(redis, pattern)

        spinner.succeed(chalk.green(`Deleted ${deleted} co-purchase key(s) — pattern: ${pattern}`))
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        await closeRedis()
      }
    })

  // ─── copurchase-rebuild ───────────────────────────────────────────────────
  intel
    .command("copurchase-rebuild")
    .description("Rebuild co-purchase sorted sets from CustomerOrderItem history")
    .option("--reset", "Delete existing keys before rebuilding", false)
    .action(async (opts: { reset: boolean }) => {
      const spinner = ora("Importing Prisma client…").start()

      try {
        const { prisma } = await import("@ibatexas/domain")
        const redis = await getRedis()

        if (opts.reset) {
          spinner.text = "Resetting existing co-purchase data…"
          const pattern = rk("copurchase:*")
          const deleted = await scanDelete(redis, pattern)
          console.log(chalk.dim(`  Deleted ${deleted} existing key(s)`))
        }

        spinner.text = "Loading order history…"

        // Load all CustomerOrderItem grouped by medusaOrderId
        const rows = await prisma.customerOrderItem.findMany({
          select: { medusaOrderId: true, productId: true },
          orderBy: { medusaOrderId: "asc" },
        })

        if (rows.length === 0) {
          spinner.warn(chalk.yellow("No CustomerOrderItem rows found — nothing to rebuild"))
          return
        }

        // Group by medusaOrderId
        const orderMap = new Map<string, string[]>()
        for (const row of rows) {
          const list = orderMap.get(row.medusaOrderId) ?? []
          list.push(row.productId)
          orderMap.set(row.medusaOrderId, list)
        }

        spinner.text = `Rebuilding co-purchase scores from ${orderMap.size} order(s)…`

        let operations = 0
        for (const [, productIds] of orderMap) {
          if (productIds.length < 2) continue

          const pipeline = redis.multi()
          for (let i = 0; i < productIds.length; i++) {
            for (let j = i + 1; j < productIds.length; j++) {
              const keyA = rk(`copurchase:${productIds[i]}`)
              const keyB = rk(`copurchase:${productIds[j]}`)
              pipeline.zIncrBy(keyA, 1, productIds[j])
              pipeline.zIncrBy(keyB, 1, productIds[i])
              operations += 2
            }
          }
          await pipeline.exec()
        }

        spinner.succeed(
          chalk.green(
            `Co-purchase rebuild complete — ${orderMap.size} orders, ${operations} score update(s)`
          )
        )
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        await closeRedis()
      }
    })

  // ─── global-score-rebuild ─────────────────────────────────────────────────
  intel
    .command("global-score-rebuild")
    .description("Rebuild the global product popularity sorted set from CustomerOrderItem history")
    .option("--reset", "Delete existing global score key before rebuilding", false)
    .action(async (opts: { reset: boolean }) => {
      const spinner = ora("Importing Prisma client…").start()

      try {
        const { prisma } = await import("@ibatexas/domain")
        const redis = await getRedis()

        const key = rk("product:global:score")

        if (opts.reset) {
          spinner.text = "Deleting existing global score key…"
          await redis.del(key)
          console.log(chalk.dim(`  Deleted key: ${key}`))
        }

        spinner.text = "Aggregating order item counts…"

        // Count total quantity ordered per product
        const counts = await prisma.customerOrderItem.groupBy({
          by: ["productId"],
          _sum: { quantity: true },
          orderBy: { _sum: { quantity: "desc" } },
        })

        if (counts.length === 0) {
          spinner.warn(chalk.yellow("No CustomerOrderItem rows found — nothing to rebuild"))
          return
        }

        spinner.text = `Writing ${counts.length} product score(s) to Redis…`

        const pipeline = redis.multi()
        for (const row of counts) {
          const score = row._sum.quantity ?? 1
          pipeline.zAdd(key, { score, value: row.productId })
        }
        await pipeline.exec()

        // Set a 30-day TTL so stale data auto-expires
        await redis.expire(key, 60 * 60 * 24 * 30)

        const top = counts.slice(0, 5)
        spinner.succeed(
          chalk.green(
            `Global score rebuild complete — ${counts.length} product(s) scored`
          )
        )
        console.log(chalk.dim("  Top 5 products by order count:"))
        for (const row of top) {
          console.log(chalk.dim(`    ${row.productId}  →  ${row._sum.quantity ?? 0} units`))
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        await closeRedis()
      }
    })

  // ─── scores-inspect ───────────────────────────────────────────────────────
  intel
    .command("scores-inspect [productId]")
    .description("Inspect co-purchase or global scores for a product")
    .option("--top <n>", "Number of top results to show", "10")
    .action(async (productId: string | undefined, opts: { top: string }) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        const topN = Number.parseInt(opts.top, 10) || 10

        if (productId) {
          // Co-purchase scores for a specific product
          const key = rk(`copurchase:${productId}`)
          const members = await redis.zRangeWithScores(key, 0, topN - 1, { REV: true })

          spinner.stop()

          if (members.length === 0) {
            console.log(chalk.yellow(`No co-purchase data for product ${productId}`))
            return
          }

          console.log(chalk.bold(`\n  Co-purchase scores for ${chalk.cyan(productId)}:\n`))
          for (const { value, score } of members) {
            console.log(`    ${chalk.cyan(value.padEnd(32))}  ${chalk.green(score.toFixed(0))}`)
          }
          console.log()
        } else {
          // Global popularity scores
          const key = rk("product:global:score")
          const members = await redis.zRangeWithScores(key, 0, topN - 1, { REV: true })

          spinner.stop()

          if (members.length === 0) {
            console.log(chalk.yellow("No global product scores found. Run: ibx intel global-score-rebuild"))
            return
          }

          console.log(chalk.bold(`\n  Top ${topN} products by global score:\n`))
          for (const { value, score } of members) {
            console.log(`    ${chalk.cyan(value.padEnd(32))}  ${chalk.green(score.toFixed(0))}`)
          }
          console.log()
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        await closeRedis()
      }
    })

  // ─── cache-stats ──────────────────────────────────────────────────────────
  intel
    .command("cache-stats")
    .description("Redis memory usage for intelligence keys (copurchase, global scores, search cache)")
    .action(async () => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()

        const groups: { label: string; pattern: string }[] = [
          { label: "Co-purchase sets",   pattern: rk("copurchase:*") },
          { label: "Global scores",      pattern: rk("product:global:*") },
          { label: "Search cache",       pattern: rk("search:*") },
          { label: "Conversation state", pattern: rk("conv:*") },
          { label: "Session data",       pattern: rk("session:*") },
        ]

        spinner.text = "Scanning keys…"

        const results: { label: string; keys: number; memoryBytes: number }[] = []

        for (const { label, pattern } of groups) {
          let cursor = 0
          let keyCount = 0
          let totalMem = 0

          do {
            const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
            cursor = result.cursor

            for (const key of result.keys) {
              keyCount++
              try {
                const mem = await redis.memoryUsage(key)
                totalMem += mem ?? 0
              } catch {
                // MEMORY USAGE not available — skip
              }
            }
          } while (cursor !== 0)

          results.push({ label, keys: keyCount, memoryBytes: totalMem })
        }

        spinner.stop()

        const totalKeys = results.reduce((s, r) => s + r.keys, 0)
        const totalMem = results.reduce((s, r) => s + r.memoryBytes, 0)

        console.log(chalk.bold(`\n  Intelligence Cache Stats\n`))

        const labelW = 22
        const keysW = 8
        console.log(
          `  ${chalk.bold("Group".padEnd(labelW))}${chalk.bold("Keys".padStart(keysW))}   ${chalk.bold("Memory")}`
        )
        console.log(`  ${"─".repeat(labelW + keysW + 14)}`)

        for (const r of results) {
          const mem = formatBytes(r.memoryBytes)
          const keysColor = r.keys > 0 ? chalk.white : chalk.gray
          const memColor = r.keys > 0 ? chalk.cyan : chalk.gray
          console.log(
            `  ${r.label.padEnd(labelW)}${keysColor(String(r.keys).padStart(keysW))}   ${memColor(mem)}`
          )
        }

        console.log(`  ${"─".repeat(labelW + keysW + 14)}`)
        console.log(
          `  ${chalk.bold("Total".padEnd(labelW))}${chalk.white(String(totalKeys).padStart(keysW))}   ${chalk.cyan(formatBytes(totalMem))}`
        )
        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        await closeRedis()
      }
    })
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
