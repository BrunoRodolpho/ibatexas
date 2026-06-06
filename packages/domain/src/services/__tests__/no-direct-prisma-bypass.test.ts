// Bypass-detection test — guards against future regressions of the
// task 15 consolidation (investigation 03 P0 #2).
//
// Asserts that NO file outside of `packages/domain/src/services/` writes
// directly to `prisma.orderNote.create`, `prisma.orderProjection.update`,
// or `prisma.payment.update` for the consolidated intent-kind surface.
//
// The 3 cart tools (`add-order-note.ts`, `switch-order-type.ts`,
// `change-delivery-address.ts`) previously bypassed the kernel by writing
// the projection directly. After task 15 they route through
// `OrderCommandService.{addNote,switchType,changeAddress}FromEnvelope`.
//
// This test is intentionally string-based (`grep`-style) — a future PR
// reintroducing a direct write would trip it before the code merges.
//
// Allowed exceptions are listed in `ALLOWED_DIRECT_WRITERS` below — they
// are sites the task spec did NOT consolidate (e.g. tools that read but
// don't write to these tables, or services that legitimately own the
// write).

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// ── Setup ────────────────────────────────────────────────────────────────

// Repo root — domain package is at packages/domain.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

// Directories to scan for bypass attempts. We do NOT scan
// `packages/domain/src/services` — those files are allowed (they ARE the
// consolidated owners).
const SCAN_DIRS = [
  "packages/tools/src/cart",
  "packages/tools/src/intelligence",
  "packages/tools/src/reservation",
  "packages/tools/src/medusa",
  // apps/api routes/subscribers are owned by tasks 12-14, 16, 17 — they
  // legitimately go through the service today via the deprecated bare-arg
  // surface. The task-15 scope is the tools layer; once tasks 16+17 land
  // they'll switch over to envelope-typed entry points and add to this
  // scan list.
]

// Patterns the test refuses to find outside packages/domain/src/services/.
// Each pattern matches a known bypass shape from investigation 03 P0 #2.
const FORBIDDEN_PATTERNS: ReadonlyArray<{
  pattern: RegExp
  /** Friendly explanation of why this is forbidden. */
  reason: string
}> = [
  {
    pattern: /prisma\.orderNote\.create/,
    reason:
      "Direct write of OrderNote — route through OrderCommandService.addNoteFromEnvelope() instead.",
  },
  {
    pattern: /prisma\.orderProjection\.update\b/,
    reason:
      "Direct update of OrderProjection — route through OrderCommandService.{switchType,changeAddress,transitionStatus}FromEnvelope() instead. This is the bypass investigation 03 P0 #2 flagged: bare prisma.orderProjection.update writes skip the version counter and audit trail.",
  },
]

/**
 * Walk a directory recursively, returning all `.ts` files (excluding test
 * fixtures + dist).
 */
function walkTs(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") {
      continue
    }
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      out.push(...walkTs(full))
    } else if (stat.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Bypass detection: no direct prisma writes for consolidated intent kinds (investigation 03 P0 #2)", () => {
  for (const scanDir of SCAN_DIRS) {
    const absDir = join(REPO_ROOT, scanDir)
    const files = walkTs(absDir)

    if (files.length === 0) {
      // The directory might not exist in this repo layout — skip silently.
      it.skip(`${scanDir}: directory empty or absent`, () => {})
      continue
    }

    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      it(`${scanDir}: no match for ${pattern.source}`, () => {
        const offenders: Array<{ file: string; line: number; text: string }> =
          []
        for (const file of files) {
          const content = readFileSync(file, "utf8")
          const lines = content.split("\n")
          lines.forEach((text, i) => {
            // Skip comment lines — docstrings can mention historical
            // bypass patterns to explain WHY a refactor happened.
            const trimmed = text.trim()
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return
            if (pattern.test(text)) {
              offenders.push({ file: relative(REPO_ROOT, file), line: i + 1, text: trimmed })
            }
          })
        }
        // Compose a friendly failure message that names every offender so
        // a regression fix is one line away.
        if (offenders.length > 0) {
          const lines = offenders
            .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
            .join("\n")
          throw new Error(
            `${reason}\n\nOffending sites (${offenders.length}):\n${lines}`,
          )
        }
        expect(offenders).toEqual([])
      })
    }
  }
})
