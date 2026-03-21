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

function formatTtl(ttl: number): string {
  if (ttl === -1) return chalk.dim("no TTL")
  if (ttl === -2) return chalk.red("expired")
  return chalk.dim(`${ttl}s`)
}

function formatGroupTtl(ttl: number | undefined): string {
  if (ttl === undefined) return "-"
  if (ttl === -1) return "none"
  return `${ttl}s`
}

// ── Redis: pattern match ────────────────────────────────────────────────────

async function debugRedisPattern(pattern: string): Promise<void> {
  const redis = await getRedis()
  const fullPattern = pattern.includes(":") ? pattern : rk(pattern)

  let cursor = 0
  const keys: string[] = []
  do {
    const result = await redis.scan(cursor, { MATCH: fullPattern, COUNT: 200 })
    cursor = result.cursor
    keys.push(...result.keys)
    if (keys.length >= 20) break
  } while (cursor !== 0)

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

    console.log(`    ${chalk.cyan(key.padEnd(50))} ${type.padEnd(8)} ${size.padEnd(10)} ${formatTtl(ttl)}`)
  }
  if (keys.length > 20) {
    console.log(chalk.dim(`    … and ${keys.length - 20} more`))
  }
  console.log()
}

// ── Redis: scan and accumulate keys for a pattern ────────────────────────────

type RedisClientDebug = Awaited<ReturnType<typeof getRedis>>

interface ScanGroupResult {
  keyCount: number
  totalMem: number
  sampleTtl?: number
}

async function scanRedisKeys(
  redis: RedisClientDebug,
  pattern: string,
  showTtl: boolean,
): Promise<ScanGroupResult> {
  let cursor = 0
  let keyCount = 0
  let totalMem = 0
  let sampleTtl: number | undefined

  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
    cursor = result.cursor
    for (const key of result.keys) {
      keyCount++
      try { totalMem += (await redis.memoryUsage(key)) ?? 0 } catch { /* skip */ }
      if (showTtl && sampleTtl === undefined) {
        sampleTtl = await redis.ttl(key)
      }
    }
  } while (cursor !== 0)

  return { keyCount, totalMem, sampleTtl }
}

// ── Redis: render group summary table ────────────────────────────────────────

function renderGroupSummaryTable(
  results: { label: string; keys: number; mem: number; ttl?: number }[],
  showTtl: boolean,
): void {
  const labelW = 22
  const header = `  ${"Group".padEnd(labelW)}${"Keys".padStart(8)}   ${"Memory".padEnd(10)}${showTtl ? "  TTL" : ""}`
  console.log(chalk.bold(header))
  console.log(`  ${"─".repeat(labelW + 22 + (showTtl ? 8 : 0))}`)

  let totalKeys = 0
  let totalMem = 0
  for (const r of results) {
    totalKeys += r.keys
    totalMem += r.mem
    const keysColor = r.keys > 0 ? chalk.white : chalk.gray
    const memColor = r.keys > 0 ? chalk.cyan : chalk.gray
    let line = `  ${r.label.padEnd(labelW)}${keysColor(String(r.keys).padStart(8))}   ${memColor(formatBytes(r.mem).padEnd(10))}`
    if (showTtl) {
      line += `  ${chalk.dim(formatGroupTtl(r.ttl))}`
    }
    console.log(line)
  }

  console.log(`  ${"─".repeat(labelW + 22 + (showTtl ? 8 : 0))}`)
  console.log(`  ${chalk.bold("Total".padEnd(labelW))}${chalk.white(String(totalKeys).padStart(8))}   ${chalk.cyan(formatBytes(totalMem))}`)
  console.log()
}

// ── Redis: group summary ────────────────────────────────────────────────────

async function debugRedisGroupSummary(showTtl: boolean): Promise<void> {
  const redis = await getRedis()

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
    const scan = await scanRedisKeys(redis, p, showTtl)
    results.push({ label, keys: scan.keyCount, mem: scan.totalMem, ttl: scan.sampleTtl })
  }

  console.log(chalk.bold("\n  Redis Key Groups\n"))
  renderGroupSummaryTable(results, showTtl)
}

// ── Typesense: schema ───────────────────────────────────────────────────────

async function debugTypesenseSchema(): Promise<void> {
  const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
  const ts = getTypesenseClient()
  const info = await ts.collections(COLLECTION).retrieve()

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
}

// ── Typesense: document by ID ───────────────────────────────────────────────

async function debugTypesenseDocument(id: string): Promise<void> {
  const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
  const ts = getTypesenseClient()

  try {
    const doc = await ts.collections(COLLECTION).documents(id).retrieve()
    console.log(chalk.bold(`\n  Document: ${id}\n`))
    console.log(JSON.stringify(doc, null, 2))
    console.log()
  } catch {
    console.log(chalk.red(`Document "${id}" not found`))
  }
}

// ── Typesense: search ───────────────────────────────────────────────────────

async function debugTypesenseSearch(query: string): Promise<void> {
  const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
  const ts = getTypesenseClient()

  const results = await ts.collections(COLLECTION).documents().search({
    q: query,
    query_by: "title,description,tags",
    per_page: 10,
  })

  const hits = results.hits ?? []
  console.log(chalk.bold(`\n  Typesense search: "${query}" — ${hits.length} hit(s)\n`))
  for (const hit of hits) {
    const doc = hit.document as Record<string, unknown>
    console.log(`    ${chalk.cyan(String(doc.title).padEnd(40))} ${chalk.dim(String(doc.id).slice(0, 24))}`)
  }
  console.log()
}

// ── Typesense: collection summary ───────────────────────────────────────────

async function debugTypesenseSummary(): Promise<void> {
  const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
  const ts = getTypesenseClient()
  const info = await ts.collections(COLLECTION).retrieve()

  console.log(chalk.bold(`\n  Typesense: ${COLLECTION}`))
  console.log(`  Documents: ${chalk.cyan(String(info.num_documents ?? 0))}`)
  console.log(`  Fields:    ${chalk.cyan(String((info.fields ?? []).length))}`)
  console.log()
}

// ── Profile: section renderers ──────────────────────────────────────────────

interface CustomerData {
  id: string
  name: string | null
  phone: string
  createdAt: Date
  addresses: Array<{ street: string; number: string; district: string; city: string; isDefault: boolean }>
  preferences: { dietaryRestrictions: unknown; allergenExclusions: unknown; favoriteCategories: unknown } | null
  reviews: Array<{ rating: number; comment: string | null }>
  orderItems: Array<{ orderedAt: Date; productId: string; quantity: number; priceInCentavos: number }>
}

function renderAddresses(addresses: CustomerData["addresses"]): void {
  console.log(chalk.bold("\n  Addresses"))
  if (addresses.length === 0) {
    console.log(chalk.gray("    None"))
    return
  }
  for (const addr of addresses) {
    const def = addr.isDefault ? chalk.green(" (default)") : ""
    console.log(`    ${addr.street}, ${addr.number} — ${addr.district}, ${addr.city}${def}`)
  }
}

function renderPreferences(preferences: CustomerData["preferences"]): void {
  console.log(chalk.bold("\n  Preferences"))
  if (!preferences) {
    console.log(chalk.gray("    None"))
    return
  }
  const p = preferences
  console.log(`    Dietary:    ${(p.dietaryRestrictions as string[]).join(", ") || "none"}`)
  console.log(`    Allergens:  ${(p.allergenExclusions as string[]).join(", ") || "none"}`)
  console.log(`    Favorites:  ${(p.favoriteCategories as string[]).join(", ") || "none"}`)
}

function renderOrders(orderItems: CustomerData["orderItems"]): void {
  console.log(chalk.bold("\n  Recent Orders"))
  if (orderItems.length === 0) {
    console.log(chalk.gray("    None"))
    return
  }
  for (const item of orderItems) {
    console.log(`    ${chalk.dim(item.orderedAt.toISOString().slice(0, 10))}  ${item.productId.slice(0, 24)}  qty=${item.quantity}  R$${(item.priceInCentavos / 100).toFixed(2)}`)
  }
}

function renderReviews(reviews: CustomerData["reviews"]): void {
  console.log(chalk.bold("\n  Recent Reviews"))
  if (reviews.length === 0) {
    console.log(chalk.gray("    None"))
    return
  }
  for (const review of reviews) {
    const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating)
    console.log(`    ${stars}  ${review.comment?.slice(0, 50) ?? "(no comment)"}`)
  }
}

interface ReservationData {
  status: string
  partySize: number
  timeSlot: { date: unknown; startTime: string | null } | null
}

function renderReservations(reservations: ReservationData[]): void {
  console.log(chalk.bold("\n  Reservations"))
  if (reservations.length === 0) {
    console.log(chalk.gray("    None"))
    return
  }
  for (const res of reservations) {
    const slotDate = res.timeSlot?.date ? new Date(res.timeSlot.date as string).toISOString().slice(0, 10) : "?"
    const slotTime = res.timeSlot?.startTime ?? "?"
    console.log(`    ${chalk.dim(slotDate)}  ${slotTime}  ${res.partySize} guest(s)  ${res.status}`)
  }
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
        if (pattern) {
          spinner.text = `Scanning: ${pattern.includes(":") ? pattern : rk(pattern)}`
          spinner.stop()
          await debugRedisPattern(pattern)
        } else {
          spinner.text = "Scanning key groups…"
          spinner.stop()
          await debugRedisGroupSummary(!!opts.ttl)
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
        if (opts.schema) {
          spinner.stop()
          await debugTypesenseSchema()
          return
        }

        if (opts.id) {
          spinner.text = `Fetching document ${opts.id}…`
          spinner.stop()
          await debugTypesenseDocument(opts.id)
          return
        }

        if (query) {
          spinner.text = `Searching: "${query}"…`
          spinner.stop()
          await debugTypesenseSearch(query)
          return
        }

        // Default: show collection summary
        spinner.stop()
        await debugTypesenseSummary()
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

        renderAddresses(customer.addresses)
        renderPreferences(customer.preferences)
        renderOrders(customer.orderItems)
        renderReviews(customer.reviews)

        // Reservations (separate query — no back-relation on Customer)
        const reservations = await prisma.reservation.findMany({
          where: { customerId },
          take: 5,
          orderBy: { createdAt: "desc" },
          include: { timeSlot: true },
        })
        renderReservations(reservations)

        console.log()
        await prisma.$disconnect()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })
}
