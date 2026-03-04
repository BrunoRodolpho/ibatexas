#!/usr/bin/env node

/**
 * Bundle size check — Phase 11.6
 *
 * Reads the Next.js build output size from .next/build-manifest.json
 * and checks that first-load JS stays under budget.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs [--budget <kB>]
 *
 * Default budget: 200 kB per route (first-load JS)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEFAULT_BUDGET_KB = 200
const budget = (() => {
  const idx = process.argv.indexOf('--budget')
  if (idx !== -1 && process.argv[idx + 1]) {
    return Number(process.argv[idx + 1])
  }
  return DEFAULT_BUDGET_KB
})()

const WEB_DIR = resolve(import.meta.dirname ?? '.', '../apps/web')
const NEXT_DIR = join(WEB_DIR, '.next')

if (!existsSync(NEXT_DIR)) {
  console.error('❌  .next directory not found. Run `pnpm --filter @ibatexas/web build` first.')
  process.exit(1)
}

// Walk the static chunks directory to measure total JS size
const chunksDir = join(NEXT_DIR, 'static', 'chunks')
if (!existsSync(chunksDir)) {
  console.error('❌  .next/static/chunks not found. Build may have failed.')
  process.exit(1)
}

function walkDir(dir) {
  let total = 0
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = walkDir(fullPath)
      total += sub.total
      count += sub.count
    } else if (entry.name.endsWith('.js')) {
      const size = statSync(fullPath).size
      total += size
      count += 1
    }
  }
  return { total, count }
}

const { total, count } = walkDir(chunksDir)
const totalKB = (total / 1024).toFixed(1)

console.log(`📦  Total JS chunks: ${count} files, ${totalKB} kB`)

// Also check the app-build-manifest for per-page sizes
const appManifestPath = join(NEXT_DIR, 'app-build-manifest.json')
if (existsSync(appManifestPath)) {
  const manifest = JSON.parse(readFileSync(appManifestPath, 'utf-8'))
  const pages = manifest.pages || {}

  let violations = 0
  console.log(`\n📊  Per-page JS budget check (${budget} kB limit):\n`)

  for (const [page, files] of Object.entries(pages)) {
    const pageSize = files.reduce((sum, f) => {
      const fp = join(NEXT_DIR, f)
      return sum + (existsSync(fp) ? statSync(fp).size : 0)
    }, 0)
    const pageSizeKB = (pageSize / 1024).toFixed(1)
    const status = pageSize / 1024 > budget ? '🔴' : '🟢'
    if (pageSize / 1024 > budget) violations++
    console.log(`  ${status}  ${pageSizeKB} kB  ${page}`)
  }

  if (violations > 0) {
    console.log(`\n❌  ${violations} page(s) exceed ${budget} kB budget.`)
    process.exit(1)
  } else {
    console.log(`\n✅  All pages within ${budget} kB budget.`)
  }
} else {
  console.log(`\n⚠️  app-build-manifest.json not found — skipping per-page check.`)
  console.log(`    Total JS: ${totalKB} kB`)
}
