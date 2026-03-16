// ibx inspect — business-level system state inspection.
// Higher-level than ibx debug — shows what the UI sees, not raw infrastructure.

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

import { rk, getRedis, closeRedis, scanCount } from "../lib/redis.js"
import { getAdminToken, medusaFetch, fetchAllProductsWithTags, findProductByHandle } from "../lib/medusa.js"

// ── Dashboard section helpers ───────────────────────────────────────────────

async function showDashboardData(): Promise<void> {
  console.log(chalk.bold("  Data"))
  try {
    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    const info = await ts.collections(COLLECTION).retrieve()
    console.log(`    Products Indexed        ${chalk.cyan(String(info.num_documents ?? 0))}`)
  } catch {
    console.log(`    Products Indexed        ${chalk.yellow("?")} (Typesense unavailable)`)
  }

  try {
    const { prisma } = await import("@ibatexas/domain")
    const reviewCount = await prisma.review.count()
    const avgResult = await prisma.review.aggregate({ _avg: { rating: true } })
    const avg = avgResult._avg.rating?.toFixed(1) ?? "0"
    console.log(`    Reviews                 ${chalk.cyan(String(reviewCount))} (avg ${avg}★)`)

    const customerCount = await prisma.customer.count()
    console.log(`    Customers               ${chalk.cyan(String(customerCount))}`)

    const orderItemCount = await prisma.customerOrderItem.count()
    console.log(`    Order Items             ${chalk.cyan(String(orderItemCount))}`)

    await prisma.$disconnect()
  } catch {
    console.log(`    Reviews/Customers       ${chalk.yellow("?")} (DB unavailable)`)
  }
}

async function showDashboardTags(): Promise<void> {
  console.log(chalk.bold("\n  Tags"))
  try {
    const products = await fetchAllProductsWithTags()
    const tagCounts = new Map<string, number>()
    for (const p of products) {
      for (const t of p.tags ?? []) {
        tagCounts.set(t.value, (tagCounts.get(t.value) ?? 0) + 1)
      }
    }
    if (tagCounts.size === 0) {
      console.log(chalk.gray("    No tags applied"))
    } else {
      for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${tag.padEnd(24)}${chalk.cyan(String(count))} products`)
      }
    }
  } catch {
    console.log(`    ${chalk.yellow("?")} (Medusa unavailable)`)
  }
}

async function showDashboardIntelligence(): Promise<void> {
  console.log(chalk.bold("\n  Intelligence"))
  try {
    const redis = await getRedis()
    const globalCount = await redis.zCard(rk("product:global:score"))
    console.log(`    Global Scores           ${chalk.cyan(String(globalCount))} products`)

    const copurchaseCount = await scanCount(redis, rk("copurchase:*"))
    console.log(`    Copurchase Keys         ${chalk.cyan(String(copurchaseCount))} relations`)
  } catch {
    console.log(`    ${chalk.yellow("?")} (Redis unavailable)`)
  }
}

async function showDashboardSystem(): Promise<void> {
  console.log(chalk.bold("\n  System"))
  try {
    const { isScenarioLocked } = await import("../lib/lock.js")
    const lock = await isScenarioLocked()
    if (lock.locked && lock.owner) {
      const elapsed = Math.round((Date.now() - new Date(lock.owner.startedAt).getTime()) / 1000)
      const lockLabel = chalk.yellow(`${lock.owner.scenario} (${elapsed}s ago)`)
      console.log(`    Scenario Lock           ${lockLabel}`)
    } else {
      console.log(`    Scenario Lock           ${chalk.green("unlocked")}`)
    }
  } catch {
    console.log(`    Scenario Lock           ${chalk.gray("unknown")}`)
  }
}

// ── Product inspection helpers ──────────────────────────────────────────────

async function showProductTypesenseData(productId: string): Promise<void> {
  try {
    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    const doc = await ts.collections(COLLECTION).documents(productId).retrieve() as Record<string, unknown>
    const rating = doc.rating ? `${Number(doc.rating).toFixed(1)}★` : "n/a"
    const reviewCount = Number(doc.reviewCount ?? 0)
    const price = doc.price ? `R$${(Number(doc.price) / 100).toFixed(2)}` : "n/a"
    const ratingLabel = chalk.cyan(`${rating} (${reviewCount} reviews)`)
    console.log(`  Rating        ${ratingLabel}`)
    console.log(`  Price         ${chalk.cyan(price)}`)
  } catch {
    console.log(`  Typesense     ${chalk.yellow("unavailable")}`)
  }
}

async function showProductOrders(productId: string): Promise<void> {
  try {
    const { prisma } = await import("@ibatexas/domain")
    const orderCount = await prisma.customerOrderItem.count({
      where: { productId },
    })
    console.log(`  Orders        ${chalk.cyan(String(orderCount))}`)
    await prisma.$disconnect()
  } catch {
    console.log(`  Orders        ${chalk.yellow("?")}`)
  }
}

async function showProductIntelligence(productId: string): Promise<void> {
  try {
    const redis = await getRedis()
    const score = await redis.zScore(rk("product:global:score"), productId)
    console.log(`  Global Score  ${chalk.cyan(score === null ? "none" : String(score))}`)

    // Copurchase
    const members = await redis.zRangeWithScores(rk(`copurchase:${productId}`), 0, 9, { REV: true })
    if (members.length > 0) {
      console.log(chalk.bold("\n  Copurchase"))
      for (const { value, score } of members) {
        console.log(`    ${chalk.dim(value.slice(0, 36).padEnd(38))} ${chalk.green(score.toFixed(0))}`)
      }
    } else {
      console.log(`\n  Copurchase    ${chalk.gray("none")}`)
    }
  } catch {
    console.log(`  Intelligence  ${chalk.yellow("Redis unavailable")}`)
  }
}

async function showProductReviews(productId: string): Promise<void> {
  try {
    const { prisma } = await import("@ibatexas/domain")
    const reviews = await prisma.review.findMany({
      where: { productId },
      orderBy: { createdAt: "desc" },
      take: 3,
    })
    if (reviews.length > 0) {
      console.log(chalk.bold("\n  Recent Reviews"))
      for (const r of reviews) {
        const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating)
        const comment = r.comment?.slice(0, 50) ?? ""
        console.log(`    ${stars}  ${chalk.dim(comment)}`)
      }
    }
    await prisma.$disconnect()
  } catch { /* skip */ }
}

// ── Analytics helpers ───────────────────────────────────────────────────────

async function showAnalyticsOrders(): Promise<{ orderItems: Array<{ priceInCentavos: number; quantity: number; productId: string }> }> {
  const { prisma } = await import("@ibatexas/domain")

  const orderItems = await prisma.customerOrderItem.findMany({
    select: { priceInCentavos: true, quantity: true, productId: true },
  })
  const totalItems = orderItems.length
  const totalRevenue = orderItems.reduce(
    (sum, item) => sum + item.priceInCentavos * item.quantity,
    0,
  )
  console.log(chalk.bold("  Orders"))
  console.log(`    Order Items             ${chalk.cyan(String(totalItems))}`)
  const revenueFormatted = `R$${(totalRevenue / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
  console.log(`    Revenue                 ${chalk.cyan(revenueFormatted)}`)

  return { orderItems }
}

async function showAnalyticsTopProducts(orderItems: Array<{ productId: string; quantity: number }>): Promise<void> {
  const productQuantities = new Map<string, number>()
  for (const item of orderItems) {
    productQuantities.set(
      item.productId,
      (productQuantities.get(item.productId) ?? 0) + item.quantity,
    )
  }
  const sorted = [...productQuantities.entries()].sort((a, b) => b[1] - a[1])

  if (sorted.length === 0) return

  const token = await getAdminToken()
  console.log(chalk.bold("\n  Top Products (by quantity)"))
  const top5 = sorted.slice(0, 5)
  for (const [productId, qty] of top5) {
    let name = productId.slice(0, 20)
    try {
      const data = await medusaFetch<{ product?: { title?: string } }>(
        `/admin/products/${productId}?fields=title`,
        { token },
      )
      if (data.product?.title) name = data.product.title
    } catch { /* use ID fallback */ }
    console.log(`    ${name.padEnd(32)} ${chalk.cyan(String(qty))}`)
  }
}

async function showAnalyticsReviews(): Promise<void> {
  const { prisma } = await import("@ibatexas/domain")

  console.log(chalk.bold("\n  Reviews"))
  const reviewCount = await prisma.review.count()
  const avgResult = await prisma.review.aggregate({ _avg: { rating: true } })
  const avg = avgResult._avg.rating?.toFixed(1) ?? "0"
  console.log(`    Total                   ${chalk.cyan(String(reviewCount))}`)
  const avgLabel = chalk.cyan(`${avg}★`)
  console.log(`    Average Rating          ${avgLabel}`)

  // Rating distribution
  const ratingDist = await prisma.review.groupBy({
    by: ["rating"],
    _count: true,
    orderBy: { rating: "desc" },
  })
  if (ratingDist.length > 0) {
    console.log(chalk.bold("\n  Rating Distribution"))
    for (const r of ratingDist) {
      const bar = "█".repeat(Math.round((r._count / reviewCount) * 30))
      console.log(`    ${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}  ${chalk.cyan(String(r._count).padStart(3))}  ${chalk.dim(bar)}`)
    }
  }
}

async function showAnalyticsCustomers(): Promise<void> {
  const { prisma } = await import("@ibatexas/domain")

  console.log(chalk.bold("\n  Customers"))
  const customerCount = await prisma.customer.count()
  const distinctOrderCustomers = await prisma.customerOrderItem.groupBy({
    by: ["customerId"],
  })
  console.log(`    Total                   ${chalk.cyan(String(customerCount))}`)
  console.log(`    With orders             ${chalk.cyan(String(distinctOrderCustomers.length))}`)

  await prisma.$disconnect()
}

// ── Integrity helpers ───────────────────────────────────────────────────────

async function checkProductIntegrity(): Promise<void> {
  console.log(chalk.bold("  Products"))
  try {
    const products = await fetchAllProductsWithTags()
    const medusaCount = products.length

    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    const info = await ts.collections(COLLECTION).retrieve()
    const tsCount = info.num_documents ?? 0

    if (medusaCount === tsCount) {
      console.log(chalk.green(`    ✅ Medusa ${medusaCount} = Typesense ${tsCount}`))
    } else {
      console.log(chalk.yellow(`    ⚠️  Medusa ${medusaCount} ≠ Typesense ${tsCount} — run: ibx db reindex`))
    }
  } catch (err) {
    console.log(chalk.yellow(`    ⚠️  Cannot compare: ${(err as Error).message}`))
  }
}

async function checkCustomerIntegrity(): Promise<void> {
  console.log(chalk.bold("\n  Customers"))
  try {
    const { prisma } = await import("@ibatexas/domain")
    const totalCustomers = await prisma.customer.count()
    const withAddresses = await prisma.address.groupBy({ by: ["customerId"] })
    const withPrefs = await prisma.customerPreferences.count()

    console.log(`    Total:          ${chalk.cyan(String(totalCustomers))}`)
    console.log(`    With addresses: ${chalk.cyan(String(withAddresses.length))}`)
    console.log(`    With prefs:     ${chalk.cyan(String(withPrefs))}`)

    if (withAddresses.length < totalCustomers) {
      console.log(chalk.yellow(`    ⚠️  ${totalCustomers - withAddresses.length} customer(s) without addresses`))
    }

    await prisma.$disconnect()
  } catch (err) {
    console.log(chalk.yellow(`    ⚠️  Cannot check: ${(err as Error).message}`))
  }
}

async function checkCopurchaseIntegrity(): Promise<void> {
  console.log(chalk.bold("\n  Copurchase"))
  try {
    const redis = await getRedis()
    const keyCount = await scanCount(redis, rk("copurchase:*"))
    if (keyCount > 0) {
      console.log(chalk.green(`    ✅ ${keyCount} relation keys`))
    } else {
      console.log(chalk.gray(`    ○  No copurchase data`))
    }
  } catch (err) {
    console.log(chalk.yellow(`    ⚠️  Cannot check: ${(err as Error).message}`))
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function registerInspectCommands(group: Command): void {
  group.description("Inspect — business-level system state (dashboard, product, page, analytics, integrity)")

  // ─── inspect (dashboard) ────────────────────────────────────────────────
  group
    .command("dashboard", { isDefault: true })
    .description("System state dashboard — data counts, tags, intelligence, lock")
    .action(async () => {
      const spinner = ora("Loading system state…").start()

      try {
        console.log(chalk.bold("\n  IBX System State\n"))
        spinner.text = "Counting data…"

        await showDashboardData()
        await showDashboardTags()
        await showDashboardIntelligence()
        await showDashboardSystem()

        spinner.stop()
        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        try { await closeRedis() } catch { /* best effort */ }
      }
    })

  // ─── inspect product <handle> ───────────────────────────────────────────
  group
    .command("product <handle>")
    .description("Product deep-dive — tags, orders, scores, copurchase, reviews")
    .action(async (handle: string) => {
      const spinner = ora(`Loading product "${handle}"…`).start()

      try {
        const product = await findProductByHandle(handle)
        if (!product) {
          spinner.fail(chalk.red(`Product "${handle}" not found`))
          process.exitCode = 1
          return
        }

        spinner.stop()
        console.log(chalk.bold(`\n  Product: ${product.title} (${product.handle})\n`))

        // Tags
        const tags = (product.tags ?? []).map((t) => t.value).join(", ") || "none"
        console.log(`  Tags          ${chalk.cyan(tags)}`)

        await showProductTypesenseData(product.id)
        await showProductOrders(product.id)
        await showProductIntelligence(product.id)
        await showProductReviews(product.id)

        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        try { await closeRedis() } catch { /* best effort */ }
      }
    })

  // ─── inspect page <page> ────────────────────────────────────────────────
  group
    .command("page <page>")
    .description("UI section state — which sections are ready (homepage, search)")
    .action(async (page: string) => {
      const spinner = ora(`Checking ${page} section state…`).start()

      try {
        if (page === "homepage") {
          spinner.stop()
          console.log(chalk.bold("\n  Homepage Section State\n"))
          await checkHomepageSections()
        } else if (page === "search") {
          spinner.stop()
          console.log(chalk.bold("\n  Search Browse Mode State\n"))
          await checkSearchSections()
        } else {
          spinner.fail(chalk.red(`Unknown page: "${page}". Available: homepage, search`))
          process.exitCode = 1
          return
        }

        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        try { await closeRedis() } catch { /* best effort */ }
      }
    })

  // ─── inspect analytics ────────────────────────────────────────────────
  group
    .command("analytics")
    .description("Analytics state — revenue, top products, customer growth, order distribution")
    .action(async () => {
      const spinner = ora("Loading analytics…").start()

      try {
        spinner.stop()
        console.log(chalk.bold("\n  Analytics State\n"))

        const { orderItems } = await showAnalyticsOrders()
        await showAnalyticsTopProducts(orderItems)
        await showAnalyticsReviews()
        await showAnalyticsCustomers()

        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ─── inspect integrity ─────────────────────────────────────────────────
  group
    .command("integrity")
    .description("Cross-system data consistency check (Medusa ↔ Typesense, orphaned refs)")
    .action(async () => {
      const spinner = ora("Running integrity checks…").start()

      try {
        spinner.stop()
        console.log(chalk.bold("\n  Data Integrity\n"))

        await checkProductIntegrity()
        await checkCustomerIntegrity()
        await checkCopurchaseIntegrity()

        console.log()
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        try { await closeRedis() } catch { /* best effort */ }
      }
    })
}

// ── Page section checkers ───────────────────────────────────────────────────

async function checkHomepageSections(): Promise<void> {
  await checkSection("Em Alta", async () => {
    const products = await fetchAllProductsWithTags()
    const count = products.filter((p) => p.tags?.some((t) => t.value === "popular")).length
    return { ready: count > 0, detail: `${count} products with popular tag (threshold: ≥1)` }
  })
  await checkSection("Pitmaster Recomenda", async () => {
    const products = await fetchAllProductsWithTags()
    const count = products.filter((p) => p.tags?.some((t) => t.value === "chef_choice")).length
    return { ready: count > 0, detail: `${count} products with chef_choice tag (threshold: ≥1)` }
  })
  await checkSection("Mais Pedidos", async () => {
    const redis = await getRedis()
    const count = await redis.zCard(rk("product:global:score"))
    return { ready: count > 0, detail: `${count} products in global score (threshold: ≥1)` }
  })
  await checkSection("Reviews", async () => {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.review.count({ where: { rating: { gte: 4 }, comment: { not: null } } })
    await prisma.$disconnect()
    return { ready: count > 0, detail: `${count} reviews with rating≥4 + comment (threshold: ≥1)` }
  })
  await checkSection("Recommendations", async () => {
    const redis = await getRedis()
    const copurchase = await scanCount(redis, rk("copurchase:*"))
    const globalScore = await redis.zCard(rk("product:global:score"))
    return { ready: copurchase > 0 && globalScore > 0, detail: `copurchase: ${copurchase}, global scores: ${globalScore}` }
  })
}

async function checkSearchSections(): Promise<void> {
  await checkSection("Pitmaster Pick", async () => {
    const products = await fetchAllProductsWithTags()
    const count = products.filter((p) => p.tags?.some((t) => t.value === "chef_choice")).length
    return { ready: count > 0, detail: `${count} products with chef_choice` }
  })
  await checkSection("Em Alta", async () => {
    const products = await fetchAllProductsWithTags()
    const count = products.filter((p) => p.tags?.some((t) => t.value === "popular")).length
    return { ready: count > 0, detail: `${count} products with popular` }
  })
  await checkSection("Mais Pedidos", async () => {
    const redis = await getRedis()
    const count = await redis.zCard(rk("product:global:score"))
    return { ready: count > 0, detail: `${count} products in global score` }
  })
  await checkSection("Categorias", async () => {
    const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
    const ts = getTypesenseClient()
    const info = await ts.collections(COLLECTION).retrieve()
    const count = info.num_documents ?? 0
    return { ready: count > 0, detail: `${count} products indexed` }
  })
}

// ── Section check helper ─────────────────────────────────────────────────────

async function checkSection(
  name: string,
  check: () => Promise<{ ready: boolean; detail: string }>,
): Promise<void> {
  try {
    const result = await check()
    const icon = result.ready ? chalk.green("✅") : chalk.yellow("⚠️ ")
    console.log(`  ${icon} ${name.padEnd(24)} ${chalk.dim(result.detail)}`)
  } catch (err) {
    const errDetail = chalk.dim(`Error: ${(err as Error).message}`)
    console.log(`  ${chalk.yellow("⚠️ ")} ${name.padEnd(24)} ${errDetail}`)
  }
}
