// ibx debug — infrastructure inspection (Redis, Typesense, customer profiles).
// Lower-level than ibx inspect — shows raw infrastructure state.

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

import { rk, getRedis, closeRedis } from "../lib/redis.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function registerDebugCommands(group: Command): void {
  group.description("Debug — infrastructure inspection (Redis, Typesense, profiles)")

  // ─── debug redis ────────────────────────────────────────────────────────
  group
    .command("redis [pattern]")
    .description("Redis key inspection — summary or pattern match")
    .option("--ttl", "Show TTL column in group summary")
    .action(async (pattern: string | undefined, opts: { ttl?: boolean }) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()

        if (pattern) {
          // Inspect keys matching the pattern
          const fullPattern = pattern.includes(":") ? pattern : rk(pattern)
          spinner.text = `Scanning: ${fullPattern}`

          let cursor = 0
          const keys: string[] = []
          do {
            const result = await redis.scan(cursor, { MATCH: fullPattern, COUNT: 200 })
            cursor = result.cursor
            keys.push(...result.keys)
            if (keys.length >= 20) break
          } while (cursor !== 0)

          spinner.stop()

          if (keys.length === 0) {
            console.log(chalk.yellow(`\n  No keys matching: ${fullPattern}\n`))
            return
          }

          console.log(chalk.bold(`\n  Keys matching: ${fullPattern} (${keys.length})\n`))

          for (const key of keys.slice(0, 20)) {
            const type = await redis.type(key)
            const ttl = await redis.ttl(key)
            let size = "?"
            try {
              const mem = await redis.memoryUsage(key)
              size = formatBytes(mem ?? 0)
            } catch { /* MEMORY USAGE may not be available */ }

            let ttlStr: string
            if (ttl === -1) {
              ttlStr = chalk.dim("no TTL")
            } else if (ttl === -2) {
              ttlStr = chalk.red("expired")
            } else {
              ttlStr = chalk.dim(`${ttl}s`)
            }
            console.log(`    ${chalk.cyan(key.padEnd(50))} ${type.padEnd(8)} ${size.padEnd(10)} ${ttlStr}`)
          }
          if (keys.length > 20) {
            console.log(chalk.dim(`    … and ${keys.length - 20} more`))
          }
          console.log()
        } else {
          // Group summary
          spinner.text = "Scanning key groups…"

          const groups: { label: string; pattern: string }[] = [
            { label: "Co-purchase sets",   pattern: rk("copurchase:*") },
            { label: "Global scores",      pattern: rk("product:global:*") },
            { label: "Search cache",       pattern: rk("search:*") },
            { label: "Conversation state", pattern: rk("conv:*") },
            { label: "Session data",       pattern: rk("session:*") },
            { label: "Scenario lock",      pattern: rk("ibx:scenario:*") },
          ]

          const results: { label: string; keys: number; mem: number; ttl?: number }[] = []

          for (const { label, pattern: p } of groups) {
            let cursor2 = 0
            let keyCount = 0
            let totalMem = 0
            let sampleTtl: number | undefined

            do {
              const result = await redis.scan(cursor2, { MATCH: p, COUNT: 200 })
              cursor2 = result.cursor
              for (const key of result.keys) {
                keyCount++
                try { totalMem += (await redis.memoryUsage(key)) ?? 0 } catch { /* skip */ }
                if (opts.ttl && sampleTtl === undefined) {
                  sampleTtl = await redis.ttl(key)
                }
              }
            } while (cursor2 !== 0)

            results.push({ label, keys: keyCount, mem: totalMem, ttl: sampleTtl })
          }

          spinner.stop()

          console.log(chalk.bold("\n  Redis Key Groups\n"))

          const labelW = 22
          const header = `  ${"Group".padEnd(labelW)}${"Keys".padStart(8)}   ${"Memory".padEnd(10)}${opts.ttl ? "  TTL" : ""}`
          console.log(chalk.bold(header))
          console.log(`  ${"─".repeat(labelW + 22 + (opts.ttl ? 8 : 0))}`)

          let totalKeys = 0
          let totalMem = 0
          for (const r of results) {
            totalKeys += r.keys
            totalMem += r.mem
            const keysColor = r.keys > 0 ? chalk.white : chalk.gray
            const memColor = r.keys > 0 ? chalk.cyan : chalk.gray
            let line = `  ${r.label.padEnd(labelW)}${keysColor(String(r.keys).padStart(8))}   ${memColor(formatBytes(r.mem).padEnd(10))}`
            if (opts.ttl) {
              let ttlStr: string
              if (r.ttl === undefined) {
                ttlStr = "-"
              } else if (r.ttl === -1) {
                ttlStr = "none"
              } else {
                ttlStr = `${r.ttl}s`
              }
              line += `  ${chalk.dim(ttlStr)}`
            }
            console.log(line)
          }

          console.log(`  ${"─".repeat(labelW + 22 + (opts.ttl ? 8 : 0))}`)
          console.log(`  ${chalk.bold("Total".padEnd(labelW))}${chalk.white(String(totalKeys).padStart(8))}   ${chalk.cyan(formatBytes(totalMem))}`)
          console.log()
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        await closeRedis()
      }
    })

  // ─── debug typesense ───────────────────────────────────────────────────
  group
    .command("typesense [query]")
    .description("Typesense inspection — doc count, search, or schema")
    .option("--schema", "Show full collection schema")
    .option("--id <productId>", "Show a single document by ID")
    .action(async (query: string | undefined, opts: { schema?: boolean; id?: string }) => {
      const spinner = ora("Connecting to Typesense…").start()

      try {
        const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
        const ts = getTypesenseClient()

        if (opts.schema) {
          const info = await ts.collections(COLLECTION).retrieve()
          spinner.stop()
          console.log(chalk.bold(`\n  Collection: ${COLLECTION}\n`))
          console.log(chalk.dim(`  Documents: ${info.num_documents ?? 0}`))
          console.log(chalk.dim(`  Fields:\n`))
          for (const field of (info.fields ?? [])) {
            const f = field as { name: string; type: string; optional?: boolean; index?: boolean }
            const optional = f.optional ? chalk.dim(" (optional)") : ""
            const indexed = f.index === false ? chalk.dim(" (not indexed)") : ""
            console.log(`    ${f.name.padEnd(24)} ${chalk.cyan(f.type)}${optional}${indexed}`)
          }
          console.log()
          return
        }

        if (opts.id) {
          spinner.text = `Fetching document ${opts.id}…`
          try {
            const doc = await ts.collections(COLLECTION).documents(opts.id).retrieve()
            spinner.stop()
            console.log(chalk.bold(`\n  Document: ${opts.id}\n`))
            console.log(JSON.stringify(doc, null, 2))
            console.log()
          } catch {
            spinner.fail(chalk.red(`Document "${opts.id}" not found`))
          }
          return
        }

        if (query) {
          spinner.text = `Searching: "${query}"…`
          const results = await ts.collections(COLLECTION).documents().search({
            q: query,
            query_by: "title,description,tags",
            per_page: 10,
          })
          spinner.stop()

          const hits = results.hits ?? []
          console.log(chalk.bold(`\n  Typesense search: "${query}" — ${hits.length} hit(s)\n`))
          for (const hit of hits) {
            const doc = hit.document as Record<string, unknown>
            console.log(`    ${chalk.cyan(String(doc.title).padEnd(40))} ${chalk.dim(String(doc.id).slice(0, 24))}`)
          }
          console.log()
          return
        }

        // Default: show collection summary
        const info = await ts.collections(COLLECTION).retrieve()
        spinner.stop()
        console.log(chalk.bold(`\n  Typesense: ${COLLECTION}`))
        console.log(`  Documents: ${chalk.cyan(String(info.num_documents ?? 0))}`)
        console.log(`  Fields:    ${chalk.cyan(String((info.fields ?? []).length))}`)
        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ─── debug profile ─────────────────────────────────────────────────────
  group
    .command("profile <customerId>")
    .description("Full customer profile dump (orders, preferences, scores, reviews, reservations)")
    .action(async (customerId: string) => {
      const spinner = ora("Loading customer profile…").start()

      try {
        const { prisma } = await import("@ibatexas/domain")

        const customer = await prisma.customer.findUnique({
          where: { id: customerId },
          include: {
            addresses: true,
            preferences: true,
            reviews: { take: 5, orderBy: { rating: "desc" } },
            orderItems: { take: 10, orderBy: { orderedAt: "desc" } },
          },
        })

        spinner.stop()

        if (!customer) {
          console.log(chalk.red(`\n  Customer "${customerId}" not found\n`))
          process.exitCode = 1
          return
        }

        console.log(chalk.bold(`\n  Customer: ${customer.name ?? customer.phone}`))
        console.log(chalk.dim(`  ID: ${customer.id}`))
        console.log(chalk.dim(`  Phone: ${customer.phone}`))
        console.log(chalk.dim(`  Created: ${customer.createdAt.toISOString()}`))

        // Addresses
        console.log(chalk.bold("\n  Addresses"))
        if (customer.addresses.length === 0) {
          console.log(chalk.gray("    None"))
        } else {
          for (const addr of customer.addresses) {
            const def = addr.isDefault ? chalk.green(" (default)") : ""
            console.log(`    ${addr.street}, ${addr.number} — ${addr.district}, ${addr.city}${def}`)
          }
        }

        // Preferences
        console.log(chalk.bold("\n  Preferences"))
        if (customer.preferences) {
          const p = customer.preferences
          console.log(`    Dietary:    ${(p.dietaryRestrictions as string[]).join(", ") || "none"}`)
          console.log(`    Allergens:  ${(p.allergenExclusions as string[]).join(", ") || "none"}`)
          console.log(`    Favorites:  ${(p.favoriteCategories as string[]).join(", ") || "none"}`)
        } else {
          console.log(chalk.gray("    None"))
        }

        // Orders
        console.log(chalk.bold("\n  Recent Orders"))
        if (customer.orderItems.length === 0) {
          console.log(chalk.gray("    None"))
        } else {
          for (const item of customer.orderItems) {
            console.log(`    ${chalk.dim(item.orderedAt.toISOString().slice(0, 10))}  ${item.productId.slice(0, 24)}  qty=${item.quantity}  R$${(item.priceInCentavos / 100).toFixed(2)}`)
          }
        }

        // Reviews
        console.log(chalk.bold("\n  Recent Reviews"))
        if (customer.reviews.length === 0) {
          console.log(chalk.gray("    None"))
        } else {
          for (const review of customer.reviews) {
            const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating)
            console.log(`    ${stars}  ${review.comment?.slice(0, 50) ?? "(no comment)"}`)
          }
        }

        // Reservations (separate query — no back-relation on Customer)
        console.log(chalk.bold("\n  Reservations"))
        const reservations = await prisma.reservation.findMany({
          where: { customerId },
          take: 5,
          orderBy: { createdAt: "desc" },
          include: { timeSlot: true },
        })
        if (reservations.length === 0) {
          console.log(chalk.gray("    None"))
        } else {
          for (const res of reservations) {
            const slotDate = res.timeSlot?.date ? new Date(res.timeSlot.date).toISOString().slice(0, 10) : "?"
            const slotTime = res.timeSlot?.startTime ?? "?"
            console.log(`    ${chalk.dim(slotDate)}  ${slotTime}  ${res.partySize} guest(s)  ${res.status}`)
          }
        }

        console.log()
        await prisma.$disconnect()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })
}
