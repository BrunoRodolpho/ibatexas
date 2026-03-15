// lib/scenario-engine.ts — full scenario engine.
// Flow: lock → load → resolve DAG → cleanup → setup → simulate → tags → rebuilds → verify → unlock

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import chalk from "chalk"
import ora from "ora"

import { ROOT } from "../utils/root.js"
import { runPipeline, type PipelineTask } from "./pipeline.js"
import { StepRegistry, type StepName } from "./steps.js"
import { ScenarioFileSchema, type ScenarioFile, type CleanupAction, type VerifyRule } from "./scenario-schema.js"
import { acquireScenarioLock } from "./lock.js"
import { isStepCached, cacheStep } from "./step-cache.js"
import { emit, emitScenarioStart, emitScenarioFinish, emitStepStart, emitStepFinish } from "./events.js"
import {
  getAdminToken,
  findOrCreateTag,
  findProductByHandle,
  updateProductTags,
  removeAllTagsFromAllProducts,
  fetchAllProductsWithTags,
} from "./medusa.js"
import { rk, getRedis, closeRedis, scanDelete, scanCount } from "./redis.js"
import { stabilizeProducts } from "./stabilize.js"

// ── Constants ────────────────────────────────────────────────────────────────

const SCENARIOS_DIR = join(ROOT, "packages", "cli", "scenarios")

// ── Public types ─────────────────────────────────────────────────────────────

export interface ScenarioOptions {
  dryRun?: boolean
  verifyOnly?: boolean
  skip?: string[]
  noCache?: boolean
  force?: boolean
  file?: string
}

export interface VerifyResult {
  key: string
  ok: boolean
  detail: string
  severity: "error" | "warning"
}

// ── Scenario discovery ───────────────────────────────────────────────────────

/**
 * Discover all .yml files in the scenarios directory.
 */
export async function discoverScenarios(): Promise<{ name: string; path: string; scenario: ScenarioFile }[]> {
  const { readdir } = await import("node:fs/promises")
  const results: { name: string; path: string; scenario: ScenarioFile }[] = []

  try {
    const files = await readdir(SCENARIOS_DIR)
    for (const file of files.sort()) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue
      const filePath = join(SCENARIOS_DIR, file)
      try {
        const raw = await readFile(filePath, "utf-8")
        const parsed = parseYaml(raw)
        const scenario = ScenarioFileSchema.parse(parsed)
        results.push({ name: scenario.name, path: filePath, scenario })
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Scenarios directory might not exist yet
  }

  return results
}

// ── Load + parse ─────────────────────────────────────────────────────────────

async function loadScenarioFile(nameOrPath: string): Promise<{ scenario: ScenarioFile; filePath: string }> {
  let filePath: string

  // If it's a file path (contains / or ends with .yml)
  if (nameOrPath.includes("/") || nameOrPath.endsWith(".yml") || nameOrPath.endsWith(".yaml")) {
    filePath = resolve(nameOrPath)
  } else {
    // Look up by name in scenarios directory
    filePath = join(SCENARIOS_DIR, `${nameOrPath}.yml`)
  }

  const raw = await readFile(filePath, "utf-8")
  const parsed = parseYaml(raw)
  const scenario = ScenarioFileSchema.parse(parsed)
  return { scenario, filePath }
}

// ── Dependency resolution ────────────────────────────────────────────────────

async function resolveDAG(scenario: ScenarioFile, visited: Set<string> = new Set()): Promise<ScenarioFile[]> {
  if (!scenario.depends || scenario.depends.length === 0) return []
  if (visited.has(scenario.name)) {
    throw new Error(`Circular dependency detected: ${scenario.name}`)
  }
  visited.add(scenario.name)

  const deps: ScenarioFile[] = []
  for (const depName of scenario.depends) {
    const { scenario: depScenario } = await loadScenarioFile(depName)
    // Recursively resolve transitive dependencies
    const transitive = await resolveDAG(depScenario, visited)
    deps.push(...transitive)
    deps.push(depScenario)
  }

  // Deduplicate by name (keep first occurrence — topological order)
  const seen = new Set<string>()
  return deps.filter((s) => {
    if (seen.has(s.name)) return false
    seen.add(s.name)
    return true
  })
}

// ── Cleanup actions ──────────────────────────────────────────────────────────

async function executeCleanup(actions: CleanupAction[]): Promise<void> {
  for (const action of actions) {
    emit({ type: "cleanup.start", timestamp: new Date().toISOString(), step: action })
    const start = Date.now()

    switch (action) {
      case "reset-tags": {
        const count = await removeAllTagsFromAllProducts()
        console.log(chalk.dim(`    Removed tags from ${count} product(s)`))
        break
      }

      case "clear-reviews": {
        const { prisma } = await import("@ibatexas/domain")
        const deleted = await prisma.review.deleteMany()
        console.log(chalk.dim(`    Deleted ${deleted.count} review(s)`))

        // syncReviewStats doesn't reset zero-review products —
        // explicitly set Typesense rating/reviewCount to null/0
        try {
          const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
          const ts = getTypesenseClient()
          const products = await fetchAllProductsWithTags()
          for (const product of products) {
            try {
              await ts
                .collections(COLLECTION)
                .documents(product.id)
                .update({ rating: 0, reviewCount: 0 })
            } catch {
              // Product might not be indexed — skip
            }
          }
          console.log(chalk.dim(`    Reset Typesense rating/reviewCount for ${products.length} product(s)`))
        } catch {
          console.log(chalk.dim("    Typesense review stats reset skipped (unavailable)"))
        }
        break
      }

      case "clear-orders": {
        const { prisma } = await import("@ibatexas/domain")
        const deleted = await prisma.customerOrderItem.deleteMany()
        console.log(chalk.dim(`    Deleted ${deleted.count} order item(s)`))
        break
      }

      case "clear-intel": {
        const redis = await getRedis()
        const copurchaseDeleted = await scanDelete(redis, rk("copurchase:*"))
        await redis.del(rk("product:global:score"))
        console.log(chalk.dim(`    Deleted ${copurchaseDeleted} copurchase key(s) + global score`))
        break
      }

      case "clear-all": {
        // Run all cleanup actions in the correct FK-safe order
        await executeCleanup(["clear-intel", "clear-orders", "clear-reviews", "reset-tags"])
        return // avoid double-emit
      }
    }

    const duration = Date.now() - start
    emit({ type: "cleanup.finish", timestamp: new Date().toISOString(), step: action, duration })
  }
}

// ── Tag application ──────────────────────────────────────────────────────────

async function applyTags(tagMap: Record<string, string[]>): Promise<string[]> {
  const entries = Object.entries(tagMap)
  if (entries.length === 0) return []

  const token = await getAdminToken()
  const affectedProductIds: string[] = []

  for (const [handle, tags] of entries) {
    const product = await findProductByHandle(handle, token)
    if (!product) {
      console.log(chalk.yellow(`    ⚠️  Product "${handle}" not found — skipping tags`))
      continue
    }

    const existingTags = product.tags ?? []
    const existingIds = existingTags.map((t) => t.id)
    const newTagIds: string[] = []

    for (const tagValue of tags) {
      // Skip if already present
      if (existingTags.some((t) => t.value === tagValue)) continue
      const tagId = await findOrCreateTag(tagValue, token)
      newTagIds.push(tagId)
      emit({ type: "tag.apply", timestamp: new Date().toISOString(), detail: `${handle}:${tagValue}` })
    }

    if (newTagIds.length > 0) {
      const allIds = [...new Set([...existingIds, ...newTagIds])]
      await updateProductTags(product.id, allIds, token)
      affectedProductIds.push(product.id)
    }
  }

  return affectedProductIds
}

// ── Verify checks ────────────────────────────────────────────────────────────

async function runVerifyChecks(verifyMap: Record<string, VerifyRule>): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []

  for (const [key, rule] of Object.entries(verifyMap)) {
    try {
      const result = await runSingleCheck(key, rule)
      results.push(result)
      emit({
        type: result.ok ? "verify.pass" : "verify.fail",
        timestamp: new Date().toISOString(),
        step: key,
        detail: result.detail,
      })
    } catch (err) {
      results.push({
        key,
        ok: false,
        detail: `Error: ${(err as Error).message}`,
        severity: "error",
      })
    }
  }

  return results
}

async function runSingleCheck(key: string, rule: VerifyRule): Promise<VerifyResult> {
  // ── products ──
  if (key === "products") {
    try {
      const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
      const ts = getTypesenseClient()
      const info = await ts.collections(COLLECTION).retrieve()
      const count = info.num_documents ?? 0
      const ok = (rule.min === undefined || count >= rule.min) &&
                 (rule.max === undefined || count <= rule.max)
      return { key, ok, detail: `${count} indexed`, severity: "error" }
    } catch {
      return { key, ok: false, detail: "Typesense unavailable", severity: "error" }
    }
  }

  // ── reviews ──
  if (key === "reviews") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.review.count()
    const ok = (rule.min === undefined || count >= rule.min) &&
               (rule.max === undefined || count <= rule.max)
    return { key, ok, detail: `${count} reviews`, severity: "error" }
  }

  // ── tag:<value> ──
  if (key.startsWith("tag:")) {
    const tagValue = key.slice(4)
    const products = await fetchAllProductsWithTags()
    const tagged = products.filter((p) => p.tags?.some((t) => t.value === tagValue))
    const count = tagged.length
    const ok = (rule.min === undefined || count >= rule.min) &&
               (rule.max === undefined || count <= rule.max)
    return { key, ok, detail: `${count} products with ${tagValue}`, severity: "error" }
  }

  // ── global-score ──
  if (key === "global-score") {
    const redis = await getRedis()
    const count = await redis.zCard(rk("product:global:score"))
    const ok = (rule.min === undefined || count >= rule.min) &&
               (rule.exists === undefined || (rule.exists ? count > 0 : count === 0))
    return { key, ok, detail: `${count} products scored`, severity: "error" }
  }

  // ── copurchase ──
  if (key === "copurchase") {
    const redis = await getRedis()
    const count = await scanCount(redis, rk("copurchase:*"))
    const ok = rule.exists !== undefined ? (rule.exists ? count > 0 : count === 0) :
               (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} copurchase keys`, severity: "error" }
  }

  // ── copurchase:<handle> ──
  if (key.startsWith("copurchase:")) {
    const handle = key.slice(11)
    const product = await findProductByHandle(handle)
    if (!product) return { key, ok: false, detail: `Product "${handle}" not found`, severity: "error" }

    const redis = await getRedis()
    const members = await redis.zRangeWithScores(rk(`copurchase:${product.id}`), 0, -1, { REV: true })
    const memberProductIds = members.map((m) => m.value)

    if (rule.contains) {
      // Check that all required handles appear in copurchase relations
      for (const requiredHandle of rule.contains) {
        const reqProduct = await findProductByHandle(requiredHandle)
        if (!reqProduct) return { key, ok: false, detail: `Required product "${requiredHandle}" not found`, severity: "error" }
        if (!memberProductIds.includes(reqProduct.id)) {
          return { key, ok: false, detail: `Missing copurchase: ${handle} → ${requiredHandle}`, severity: "error" }
        }
      }
      return { key, ok: true, detail: `All copurchase relations present`, severity: "error" }
    }

    const ok = rule.exists !== undefined ? (rule.exists ? members.length > 0 : members.length === 0) :
               (rule.min === undefined || members.length >= rule.min)
    return { key, ok, detail: `${members.length} copurchase relations for ${handle}`, severity: "error" }
  }

  // ── customers ──
  if (key === "customers") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.customer.count()
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} customers`, severity: "error" }
  }

  // ── addresses ──
  if (key === "addresses") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.address.count()
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} addresses`, severity: "error" }
  }

  // ── preferences ──
  if (key === "preferences") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.customerPreferences.count()
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} preferences`, severity: "error" }
  }

  // ── order-items ──
  if (key === "order-items") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.customerOrderItem.count()
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} order items`, severity: "error" }
  }

  // ── reservations ──
  if (key === "reservations") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.reservation.count()
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} reservations`, severity: "error" }
  }

  // ── tables ──
  if (key === "tables") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.table.count()
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} tables`, severity: "error" }
  }

  // ── delivery-zones ──
  if (key === "delivery-zones") {
    const { prisma } = await import("@ibatexas/domain")
    const count = await prisma.deliveryZone.count({ where: { active: true } })
    const ok = (rule.min === undefined || count >= rule.min)
    return { key, ok, detail: `${count} active zones`, severity: "error" }
  }

  // ── api:<path> ──
  if (key.startsWith("api:")) {
    const path = key.slice(4)
    const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
    try {
      const res = await fetch(`${apiUrl}${path}`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return { key, ok: false, detail: `API ${res.status}`, severity: "warning" }
      const data = (await res.json()) as Record<string, unknown>
      // Count array-like response
      const items = Array.isArray(data) ? data : (data.products ?? data.items ?? data.results ?? [])
      const count = Array.isArray(items) ? items.length : 0
      const ok = (rule.min === undefined || count >= rule.min) &&
                 (rule.exists === undefined || (rule.exists ? count > 0 : count === 0))
      return { key, ok, detail: `${count} items from API`, severity: "warning" }
    } catch {
      return { key, ok: false, detail: "API unreachable (is ibx dev api running?)", severity: "warning" }
    }
  }

  // ── ranking ──
  if (key === "ranking" && rule.order) {
    const redis = await getRedis()
    const scores: { handle: string; score: number }[] = []
    for (const handle of rule.order) {
      const product = await findProductByHandle(handle)
      if (!product) return { key, ok: false, detail: `Product "${handle}" not found`, severity: "error" }
      const score = await redis.zScore(rk("product:global:score"), product.id)
      scores.push({ handle, score: score ?? 0 })
    }
    // Check that scores are in descending order
    for (let i = 0; i < scores.length - 1; i++) {
      if (scores[i].score < scores[i + 1].score) {
        return {
          key,
          ok: false,
          detail: `${scores[i].handle} (${scores[i].score}) should rank higher than ${scores[i + 1].handle} (${scores[i + 1].score})`,
          severity: "error",
        }
      }
    }
    return { key, ok: true, detail: "Ranking order correct", severity: "error" }
  }

  // ── Unknown key ──
  return { key, ok: false, detail: `Unknown verify key: ${key}`, severity: "warning" }
}

// ── Main engine ──────────────────────────────────────────────────────────────

export async function runScenario(nameOrPath: string, opts: ScenarioOptions = {}): Promise<boolean> {
  const totalStart = Date.now()

  // 1. Load scenario
  const { scenario, filePath } = await loadScenarioFile(opts.file ?? nameOrPath)
  console.log(chalk.bold(`\n  Scenario: ${scenario.name}`))
  console.log(chalk.dim(`  ${scenario.description}`))
  if (scenario.estimatedTime) {
    console.log(chalk.dim(`  Estimated: ~${scenario.estimatedTime}s`))
  }
  console.log()

  // Dry run — just print what would happen
  if (opts.dryRun) {
    return printDryRun(scenario)
  }

  // Verify only — skip everything except verify
  if (opts.verifyOnly) {
    return await runVerifyOnlyMode(scenario)
  }

  // 2. Acquire lock
  let releaseLock: (() => Promise<void>) | undefined
  try {
    releaseLock = await acquireScenarioLock(scenario.name, { force: opts.force })
    emit({ type: "lock.acquire", timestamp: new Date().toISOString(), scenario: scenario.name })
  } catch (err) {
    console.error(chalk.red(`  ${(err as Error).message}`))
    return false
  }

  emitScenarioStart(scenario.name)
  let success = true

  try {
    // 3. Resolve dependency DAG
    const deps = await resolveDAG(scenario)
    if (deps.length > 0) {
      console.log(chalk.dim(`  Resolving dependencies: ${deps.map((d) => d.name).join(" → ")}\n`))
      for (const dep of deps) {
        // Run dependency setup steps
        if (dep.setup.length > 0) {
          const tasks = stepsToTasks(dep.setup as StepName[], opts)
          const result = await runPipeline(tasks, { skip: opts.skip })
          if (!result.ok) {
            success = false
            return success
          }
        }
      }
    }

    // 4. Cleanup
    if (scenario.cleanup && scenario.cleanup.length > 0) {
      console.log(chalk.bold("  Cleanup"))
      await executeCleanup(scenario.cleanup)
      console.log()
    }

    // 5. Setup
    if (scenario.setup.length > 0) {
      console.log(chalk.bold("  Setup"))
      const tasks = stepsToTasks(scenario.setup as StepName[], opts)
      const result = await runPipeline(tasks, { skip: opts.skip })
      if (!result.ok) {
        success = false
        return success
      }
      console.log()
    }

    // 6. Simulate (if present)
    if (scenario.simulate) {
      console.log(chalk.bold("  Simulate"))
      const { runSimulation } = await import("./simulator.js")
      const simResult = await runSimulation({
        customers: scenario.simulate.customers,
        days: scenario.simulate.days,
        ordersPerDay: scenario.simulate.ordersPerDay,
        seed: scenario.simulate.seed,
        behavior: scenario.simulate.behavior,
        reviews: scenario.simulate.reviews,
      })
      console.log(chalk.dim(`    ${simResult.customersCreated} customers, ${simResult.ordersCreated} orders, ${simResult.reviewsCreated} reviews`))
      console.log()
    }

    // 7. Tags
    const tagEntries = Object.entries(scenario.tags)
    if (tagEntries.length > 0) {
      const spinner = ora(`  Applying ${tagEntries.length} tag rule(s)…`).start()
      const affectedProductIds = await applyTags(scenario.tags)
      // Stabilize: reindex affected products to Typesense + flush cache (deterministic, no blind wait)
      if (affectedProductIds.length > 0) {
        spinner.text = `  Stabilizing ${affectedProductIds.length} product(s) in Typesense…`
        await stabilizeProducts(affectedProductIds)
      }
      spinner.succeed(chalk.green(`  Applied ${tagEntries.length} tag rule(s)`))
      console.log()
    }

    // 8. Rebuilds
    if (scenario.rebuilds.length > 0) {
      console.log(chalk.bold("  Rebuilds"))
      const tasks = stepsToTasks(scenario.rebuilds as StepName[], opts)
      const result = await runPipeline(tasks, { skip: opts.skip })
      if (!result.ok) {
        success = false
        return success
      }
      console.log()
    }

    // 9. Verify
    const verifyEntries = Object.entries(scenario.verify)
    if (verifyEntries.length > 0) {
      console.log(chalk.bold("  Verify\n"))
      const results = await runVerifyChecks(scenario.verify)
      printVerifyResults(results)
      const failures = results.filter((r) => !r.ok && r.severity === "error")
      if (failures.length > 0) success = false
    }
  } finally {
    // 10. Unlock
    if (releaseLock) {
      await releaseLock()
      emit({ type: "lock.release", timestamp: new Date().toISOString(), scenario: scenario.name })
    }

    // Disconnect
    try { await closeRedis() } catch { /* best effort */ }
    try {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.$disconnect()
    } catch { /* best effort */ }
  }

  const totalDuration = Date.now() - totalStart
  emitScenarioFinish(scenario.name, totalDuration)

  if (success) {
    console.log(chalk.green(`\n  ✅  Scenario "${scenario.name}" complete (${(totalDuration / 1000).toFixed(1)}s)\n`))
  } else {
    console.log(chalk.red(`\n  ❌  Scenario "${scenario.name}" failed (${(totalDuration / 1000).toFixed(1)}s)\n`))
  }

  return success
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stepsToTasks(steps: StepName[], opts: ScenarioOptions): PipelineTask[] {
  return steps.map((name) => ({
    name,
    label: StepRegistry[name].label,
    run: StepRegistry[name].run,
  }))
}

function printDryRun(scenario: ScenarioFile): boolean {
  console.log(chalk.bold("  Dry Run — steps that would execute:\n"))

  if (scenario.cleanup?.length) {
    console.log(chalk.dim("  Cleanup:"))
    for (const action of scenario.cleanup) {
      console.log(`    ${chalk.yellow("○")} ${action}`)
    }
    console.log()
  }

  if (scenario.setup.length > 0) {
    console.log(chalk.dim("  Setup:"))
    for (const step of scenario.setup) {
      const def = StepRegistry[step as StepName]
      console.log(`    ${chalk.cyan("○")} ${def?.label ?? step}`)
    }
    console.log()
  }

  if (scenario.simulate) {
    console.log(chalk.dim("  Simulate:"))
    console.log(`    ${chalk.cyan("○")} ${scenario.simulate.customers} customers, ${scenario.simulate.days} days, ${scenario.simulate.ordersPerDay} orders/day, seed=${scenario.simulate.seed}`)
    if (scenario.simulate.behavior) {
      const dist = Object.entries(scenario.simulate.behavior).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(", ")
      console.log(`    ${chalk.cyan("○")} Profiles: ${dist}`)
    }
    console.log()
  }

  const tagEntries = Object.entries(scenario.tags)
  if (tagEntries.length > 0) {
    console.log(chalk.dim("  Tags:"))
    for (const [handle, tags] of tagEntries) {
      console.log(`    ${chalk.cyan("○")} ${handle}: ${tags.join(", ")}`)
    }
    console.log()
  }

  if (scenario.rebuilds.length > 0) {
    console.log(chalk.dim("  Rebuilds:"))
    for (const step of scenario.rebuilds) {
      const def = StepRegistry[step as StepName]
      console.log(`    ${chalk.cyan("○")} ${def?.label ?? step}`)
    }
    console.log()
  }

  const verifyEntries = Object.entries(scenario.verify)
  if (verifyEntries.length > 0) {
    console.log(chalk.dim("  Verify:"))
    for (const [key, rule] of verifyEntries) {
      const ruleStr = Object.entries(rule)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
      console.log(`    ${chalk.cyan("○")} ${key}: ${ruleStr}`)
    }
    console.log()
  }

  return true
}

async function runVerifyOnlyMode(scenario: ScenarioFile): Promise<boolean> {
  const verifyEntries = Object.entries(scenario.verify)
  if (verifyEntries.length === 0) {
    console.log(chalk.yellow("  No verify rules defined.\n"))
    return true
  }

  console.log(chalk.bold("  Verify (only)\n"))
  const results = await runVerifyChecks(scenario.verify)
  printVerifyResults(results)

  try { await closeRedis() } catch { /* best effort */ }
  try {
    const { prisma } = await import("@ibatexas/domain")
    await prisma.$disconnect()
  } catch { /* best effort */ }

  const failures = results.filter((r) => !r.ok && r.severity === "error")
  return failures.length === 0
}

function printVerifyResults(results: VerifyResult[]): void {
  for (const r of results) {
    const icon = r.ok ? chalk.green("✅") : r.severity === "error" ? chalk.red("❌") : chalk.yellow("⚠️ ")
    const detail = r.ok ? chalk.dim(r.detail) : chalk.yellow(r.detail)
    console.log(`    ${icon}  ${r.key.padEnd(24)} ${detail}`)
  }
  console.log()
}
