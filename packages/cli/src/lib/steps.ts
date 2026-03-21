// lib/steps.ts — typed StepRegistry.
// Extracted from test.ts::buildSeedPipeline() so scenario engine,
// matrix engine, and test commands all share the same step definitions.

import chalk from "chalk"
import { execa } from "execa"
import type { MedusaProductInput } from "@ibatexas/tools"
import { ROOT } from "../utils/root.js"
import { getAdminToken, getMedusaUrl } from "./medusa.js"
import { rk } from "./redis.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface StepDefinition {
  label: string
  run: () => Promise<void>
}

// ── Step implementations ─────────────────────────────────────────────────────

async function runSeedProducts(): Promise<void> {
  // Check if products already exist — seed is not idempotent (creates regions, etc.)
  try {
    const token = await getAdminToken()
    const base = getMedusaUrl()
    const res = await fetch(
      `${base}/admin/products?limit=1&fields=id`,
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } },
    )
    if (res.ok) {
      const data = (await res.json()) as { products?: unknown[] }
      if ((data.products ?? []).length > 0) {
        console.log(chalk.dim("    Products already exist — skipping seed"))
        return
      }
    }
  } catch {
    // Medusa not available or auth failed — proceed with seed
  }

  await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:seed"], {
    cwd: ROOT,
    stdio: "pipe",
  })
}

async function runReindex(): Promise<void> {
  const {
    ensureCollectionExists,
    indexProductsBatch,
    invalidateAllQueryCache,
    closeRedisClient,
  } = await import("@ibatexas/tools")

  await ensureCollectionExists()

  // Fetch products from Medusa
  const token = await getAdminToken()
  const base = getMedusaUrl()
  const allProducts: unknown[] = []
  let offset = 0
  const limit = 100

  while (true) {
    const res = await fetch(
      `${base}/admin/products?limit=${limit}&offset=${offset}&fields=*variants,*variants.price_set,*variants.price_set.prices,*tags,*categories,*images`,
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`Failed to fetch products (${res.status})`)
    const data = (await res.json()) as { products?: unknown[] }
    const products = data.products ?? []
    allProducts.push(...products)
    if (products.length < limit) break
    offset += limit
  }

  if (allProducts.length === 0) throw new Error("No products found in Medusa")
  await indexProductsBatch(allProducts as MedusaProductInput[])
  await invalidateAllQueryCache()
  await closeRedisClient()
}

async function runSeedDomain(): Promise<void> {
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:tables"], {
    cwd: ROOT,
    stdio: "pipe",
  })
}

async function runSeedHomepage(): Promise<void> {
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:homepage"], {
    cwd: ROOT,
    stdio: "pipe",
  })
}

async function runSeedDelivery(): Promise<void> {
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:delivery"], {
    cwd: ROOT,
    stdio: "pipe",
  })
}

async function runSeedOrders(): Promise<void> {
  await execa("pnpm", ["--filter", "@ibatexas/domain", "db:seed:orders"], {
    cwd: ROOT,
    stdio: "pipe",
  })
}

async function runSyncReviews(): Promise<void> {
  const { syncReviewStats } = await import("@ibatexas/tools")
  const result = await syncReviewStats()
  console.log(chalk.dim(`    ${result.synced} synced, ${result.skipped} skipped`))
}

async function runCopurchaseRebuild(): Promise<void> {
  const { getRedisClient, closeRedisClient } = await import("@ibatexas/tools")
  const { prisma } = await import("@ibatexas/domain")
  const redis = await getRedisClient()

  // Load order history
  const rows = await prisma.customerOrderItem.findMany({
    select: { medusaOrderId: true, productId: true },
    orderBy: { medusaOrderId: "asc" },
  })

  if (rows.length === 0) return

  // Group by order
  const orderMap = new Map<string, string[]>()
  for (const row of rows) {
    const list = orderMap.get(row.medusaOrderId) ?? []
    list.push(row.productId)
    orderMap.set(row.medusaOrderId, list)
  }

  // Build co-purchase pairs
  for (const [, productIds] of orderMap) {
    if (productIds.length < 2) continue
    const pipeline = redis.multi()
    for (let i = 0; i < productIds.length; i++) {
      for (let j = i + 1; j < productIds.length; j++) {
        pipeline.zIncrBy(rk(`copurchase:${productIds[i]}`), 1, productIds[j])
        pipeline.zIncrBy(rk(`copurchase:${productIds[j]}`), 1, productIds[i])
      }
    }
    await pipeline.exec()
  }

  await closeRedisClient()
}

async function runGlobalScoreRebuild(): Promise<void> {
  const { getRedisClient, closeRedisClient } = await import("@ibatexas/tools")
  const { prisma } = await import("@ibatexas/domain")
  const redis = await getRedisClient()

  const counts = await prisma.customerOrderItem.groupBy({
    by: ["productId"],
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
  })

  if (counts.length === 0) return

  const key = rk("product:global:score")
  const pipeline = redis.multi()
  for (const row of counts) {
    pipeline.zAdd(key, { score: row._sum.quantity ?? 1, value: row.productId })
  }
  await pipeline.exec()
  await redis.expire(key, 60 * 60 * 24 * 30)

  await closeRedisClient()
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const StepRegistry = {
  "seed-products":      { label: "Seed Medusa products",             run: runSeedProducts },
  "reindex":            { label: "Reindex products into Typesense",  run: runReindex },
  "seed-domain":        { label: "Seed domain tables",               run: runSeedDomain },
  "seed-homepage":      { label: "Seed customers + reviews",         run: runSeedHomepage },
  "seed-delivery":      { label: "Seed delivery zones + addresses",  run: runSeedDelivery },
  "seed-orders":        { label: "Seed order history + reservations", run: runSeedOrders },
  "sync-reviews":       { label: "Sync review stats to Typesense",  run: runSyncReviews },
  "intel-copurchase":   { label: "Rebuild co-purchase matrix",       run: runCopurchaseRebuild },
  "intel-global-score": { label: "Rebuild global product scores",    run: runGlobalScoreRebuild },
} as const satisfies Record<string, StepDefinition>

export type StepName = keyof typeof StepRegistry

/** All valid step names as an array (useful for Zod enums). */
export const STEP_NAMES = Object.keys(StepRegistry) as StepName[]
