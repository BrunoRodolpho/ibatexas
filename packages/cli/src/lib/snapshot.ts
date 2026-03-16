// lib/snapshot.ts — Snapshot save/load/compare for matrix state results.
// Stored in packages/cli/snapshots/<matrix>/<state>.json, committed to git.
// Used by `ibx matrix <name> --snapshot` and `ibx matrix <name> --verify`.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import chalk from "chalk"

import { ROOT } from "../utils/root.js"
import type { MatrixStateResult } from "./matrix.js"

// ── Constants ────────────────────────────────────────────────────────────────

const SNAPSHOTS_DIR = join(ROOT, "packages", "cli", "snapshots")

// ── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotEntry {
  stateIndex: number
  activeVars: string[]
  checks: {
    section: string
    expected: "visible" | "hidden"
    actual: "pass" | "fail"
    detail: string
  }[]
  ok: boolean
  savedAt: string
}

export interface SnapshotDiff {
  stateIndex: number
  diffs: {
    section: string
    expected: string
    snapshotActual: string
    currentActual: string
  }[]
}

// ── Paths ────────────────────────────────────────────────────────────────────

function snapshotDir(matrixName: string): string {
  return join(SNAPSHOTS_DIR, matrixName)
}

function snapshotPath(matrixName: string, stateIndex: number): string {
  return join(snapshotDir(matrixName), `state-${stateIndex}.json`)
}

// ── Save ─────────────────────────────────────────────────────────────────────

/**
 * Save a matrix state result as a snapshot.
 */
export async function saveSnapshot(
  matrixName: string,
  result: MatrixStateResult,
): Promise<string> {
  const dir = snapshotDir(matrixName)
  await mkdir(dir, { recursive: true })

  const entry: SnapshotEntry = {
    stateIndex: result.stateIndex,
    activeVars: result.activeVars,
    checks: result.checks,
    ok: result.ok,
    savedAt: new Date().toISOString(),
  }

  const filePath = snapshotPath(matrixName, result.stateIndex)
  await writeFile(filePath, JSON.stringify(entry, null, 2) + "\n", "utf-8")
  return filePath
}

/**
 * Save multiple results as snapshots.
 */
export async function saveSnapshots(
  matrixName: string,
  results: MatrixStateResult[],
): Promise<number> {
  let count = 0
  for (const result of results) {
    await saveSnapshot(matrixName, result)
    count++
  }
  return count
}

// ── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load a saved snapshot for a specific state.
 * Returns null if no snapshot exists.
 */
export async function loadSnapshot(
  matrixName: string,
  stateIndex: number,
): Promise<SnapshotEntry | null> {
  try {
    const filePath = snapshotPath(matrixName, stateIndex)
    const raw = await readFile(filePath, "utf-8")
    return JSON.parse(raw) as SnapshotEntry
  } catch {
    return null
  }
}

// ── Compare ──────────────────────────────────────────────────────────────────

/**
 * Compare a current matrix result against a saved snapshot.
 * Returns diffs if the results don't match, or null if they match.
 */
export function compareSnapshot(
  snapshot: SnapshotEntry,
  current: MatrixStateResult,
): SnapshotDiff | null {
  const diffs: SnapshotDiff["diffs"] = []

  for (const snCheck of snapshot.checks) {
    const curCheck = current.checks.find((c) => c.section === snCheck.section)
    if (!curCheck) {
      diffs.push({
        section: snCheck.section,
        expected: snCheck.expected,
        snapshotActual: snCheck.actual,
        currentActual: "missing",
      })
      continue
    }

    if (snCheck.actual !== curCheck.actual) {
      diffs.push({
        section: snCheck.section,
        expected: snCheck.expected,
        snapshotActual: snCheck.actual,
        currentActual: curCheck.actual,
      })
    }
  }

  // Check for new sections in current that aren't in snapshot
  for (const curCheck of current.checks) {
    if (!snapshot.checks.some((s) => s.section === curCheck.section)) {
      diffs.push({
        section: curCheck.section,
        expected: curCheck.expected,
        snapshotActual: "missing",
        currentActual: curCheck.actual,
      })
    }
  }

  return diffs.length > 0 ? { stateIndex: current.stateIndex, diffs } : null
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * Verify current results against saved snapshots.
 * Returns diffs for all states that don't match.
 */
export async function verifySnapshots(
  matrixName: string,
  results: MatrixStateResult[],
): Promise<{ matched: number; drifted: number; missing: number; diffs: SnapshotDiff[] }> {
  let matched = 0
  let drifted = 0
  let missing = 0
  const diffs: SnapshotDiff[] = []

  for (const result of results) {
    const snapshot = await loadSnapshot(matrixName, result.stateIndex)
    if (!snapshot) {
      missing++
      continue
    }

    const diff = compareSnapshot(snapshot, result)
    if (diff) {
      drifted++
      diffs.push(diff)
    } else {
      matched++
    }
  }

  return { matched, drifted, missing, diffs }
}

/**
 * Print snapshot verification results.
 */
export function printVerifyResults(verification: {
  matched: number
  drifted: number
  missing: number
  diffs: SnapshotDiff[]
}): void {
  if (verification.drifted === 0 && verification.missing === 0) {
    console.log(chalk.green(`  ✅  All ${verification.matched} state(s) match snapshots\n`))
    return
  }

  if (verification.drifted > 0) {
    console.log(chalk.red(`  ❌  ${verification.drifted} state(s) drifted from snapshots:\n`))
    for (const diff of verification.diffs) {
      console.log(chalk.bold(`    State ${diff.stateIndex}:`))
      for (const d of diff.diffs) {
        console.log(chalk.red(`      ${d.section}: snapshot=${d.snapshotActual}, current=${d.currentActual}`))
      }
    }
    console.log()
  }

  if (verification.missing > 0) {
    console.log(chalk.yellow(`  ⚠️  ${verification.missing} state(s) have no saved snapshot (run --snapshot first)\n`))
  }
}
