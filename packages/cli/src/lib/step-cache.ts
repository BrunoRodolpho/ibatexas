// lib/step-cache.ts — step input hashing and caching.
// Skips expensive steps when inputs haven't changed.
// Cache lives in .ibx/cache/steps/<stepName>.json

import { createHash } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { ROOT } from "../utils/root.js"
import type { StepName } from "./steps.js"

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = join(ROOT, ".ibx", "cache", "steps")

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
}

// ── Input hashing per step ──────────────────────────────────────────────────

/**
 * Map of step names to the files that define their input.
 * If a step's input files haven't changed, we can skip re-running it.
 * Steps with `null` always re-run (depend on runtime state).
 */
const STEP_INPUT_FILES: Record<StepName, string[] | null> = {
  "seed-products":      ["apps/commerce/src/seed-data.ts"],
  "reindex":            null, // depends on Typesense state + product count
  "seed-domain":        ["packages/domain/src/seed-tables.ts"],
  "seed-homepage":      ["packages/domain/src/seed-homepage.ts"],
  "seed-delivery":      ["packages/domain/src/seed-delivery.ts"],
  "seed-orders":        ["packages/domain/src/seed-orders.ts"],
  "sync-reviews":       null, // depends on review count at runtime
  "intel-copurchase":   null, // depends on order history at runtime
  "intel-global-score": null, // depends on order history at runtime
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(join(ROOT, filePath), "utf-8")
    return createHash("sha256").update(content).digest("hex").slice(0, 16)
  } catch {
    return "missing"
  }
}

async function computeInputHash(stepName: StepName): Promise<string | null> {
  const files = STEP_INPUT_FILES[stepName]
  if (!files) return null // always re-run

  const hashes: string[] = []
  for (const file of files) {
    hashes.push(await hashFile(file))
  }
  return createHash("sha256").update(hashes.join(":")).digest("hex").slice(0, 16)
}

// ── Cache entry ──────────────────────────────────────────────────────────────

interface CacheEntry {
  stepName: string
  inputHash: string
  completedAt: string
  durationMs: number
}

function cachePath(stepName: StepName): string {
  return join(CACHE_DIR, `${stepName}.json`)
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a step is cached (input hash matches).
 * Returns the cached entry if valid, or null if the step needs to re-run.
 */
export async function isStepCached(stepName: StepName): Promise<CacheEntry | null> {
  const inputHash = await computeInputHash(stepName)
  if (!inputHash) return null // always re-run

  try {
    const raw = await readFile(cachePath(stepName), "utf-8")
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.inputHash === inputHash) return entry
    return null
  } catch {
    return null
  }
}

/**
 * Write a cache entry after a step completes successfully.
 */
export async function cacheStep(stepName: StepName, durationMs: number): Promise<void> {
  const inputHash = await computeInputHash(stepName)
  if (!inputHash) return // can't cache runtime-dependent steps

  await ensureCacheDir()

  const entry: CacheEntry = {
    stepName,
    inputHash,
    completedAt: new Date().toISOString(),
    durationMs,
  }

  await writeFile(cachePath(stepName), JSON.stringify(entry, null, 2))
}

/**
 * Delete all cached step entries.
 */
export async function invalidateCache(): Promise<void> {
  const { rm } = await import("node:fs/promises")
  try {
    await rm(CACHE_DIR, { recursive: true, force: true })
  } catch {
    // Directory might not exist
  }
}
