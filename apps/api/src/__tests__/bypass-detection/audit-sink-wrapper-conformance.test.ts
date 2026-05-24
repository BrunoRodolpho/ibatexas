// audit-2026-05-24 — Hardening test T2: AuditSink wrapper-call conformance.
//
// # Why this test exists
//
// SYNTHESIS.md §H2 + tasks/h2-wrapper-audit-sink-architecture.md: pre-H2
// the 4 wrapper meta types declared `auditSink` as OPTIONAL. The wrapper
// emitted the audit record inside `if (meta.auditSink) { … }`, so any
// caller that omitted the field silently skipped the emit. Pre-H2 inventory
// counted ~28 wrapper-call sites in `@ibatexas/tools` (cart tools) + `apps/api/src/whatsapp/client.ts`
// that fell through that hole — the audit-trail invariant from CLAUDE.md
// rule #9 ("every decision is audited") was broken for cart-tool egress.
//
// H2 §A1 closes the hole: the leaf package `@ibatexas/audit-sink` owns
// `getAuditSink()`, every wrapper meta now requires `auditSink`, and the
// 28 wrapper-call sites were swept to pass `auditSink: getAuditSink()`.
//
// This conformance suite is BELT-AND-SUSPENDERS over the type-level
// requirement: if a future refactor flips the meta back to optional (e.g.
// during an upgrade to a wrapper version that re-introduces fail-open),
// the type system stops enforcing the contract — but this static-grep
// catches the regression before it lands.
//
// Modeled on T1 (`nx-park-conformance.test.ts`) and T7
// (`idempotency-key-conformance.test.ts`) — same walk + comment-strip +
// balanced-paren extraction pattern.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, it, expect } from "vitest"

// ── Repo root ─────────────────────────────────────────────────────────────

// __dirname → apps/api/src/__tests__/bypass-detection
// repo root  → ../../../../../
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

// ── Scan surfaces ─────────────────────────────────────────────────────────

/**
 * Directories scanned for wrapper-call sites. Mirrors the T7 scan set —
 * any new directory hosting a wrapper-call site MUST be added here.
 */
const SCAN_DIRS = [
  "apps/api/src/routes",
  "apps/api/src/jobs",
  "apps/api/src/subscribers",
  "apps/api/src/whatsapp",
  "packages/tools/src/cart",
  "packages/tools/src/medusa",
  "packages/tools/src/twilio",
  "packages/tools/src/stripe",
] as const

/**
 * Wrapper source files — they DEFINE the wrappers, don't CALL them. We
 * skip these in the scan so the wrapper's own `runKernelAndAudit` body
 * (which uses `meta.auditSink.emit(...)` rather than passing it) doesn't
 * get flagged.
 */
const WRAPPER_DEFINITION_FILES: ReadonlySet<string> = new Set<string>([
  "packages/tools/src/medusa/adjudicated.ts",
  "packages/tools/src/medusa/store-adjudicated.ts",
  "packages/tools/src/stripe/adjudicated.ts",
  "packages/tools/src/twilio/adjudicated.ts",
])

// ── Forbidden patterns ────────────────────────────────────────────────────

/**
 * Match the function reference + opening `(` of a wrapper call. Same
 * pattern as T7's WRAPPER_CALL_PATTERN. The arg-block extraction step
 * (balanced-paren walker) pulls the full meta literal and checks for
 * the literal `auditSink:` field.
 *
 * Using the literal field name is intentional — a future rename surfaces
 * here forcing the refactor author to update this test alongside.
 */
const WRAPPER_CALL_PATTERN =
  /\b(medusaStoreAdjudicated(?:\.\w+)+|medusaAdjudicated(?!\w)|stripeAdjudicated(?:\.\w+)+|twilioAdjudicated(?:\.\w+)+)\s*(?:<[^>]*?>)?\s*\(/gs

// ── Walker (mirror of bypass-detection.test.ts walkTs) ────────────────────

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

/**
 * Strip line + block comments, preserving newlines. Mirrors the helper
 * from T1 / T7.
 */
function stripComments(src: string): string {
  let out = ""
  const len = src.length
  let i = 0
  while (i < len) {
    const c = src[i]!
    const next = src[i + 1] ?? ""
    if (c === "/" && next === "/") {
      while (i < len && src[i] !== "\n") {
        out += " "
        i++
      }
    } else if (c === "/" && next === "*") {
      out += "  "
      i += 2
      while (i < len) {
        if (src[i] === "*" && src[i + 1] === "/") {
          out += "  "
          i += 2
          break
        }
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

/**
 * Given an opening `(` offset, return the matching close-paren offset
 * (balanced across nested parens/braces/brackets, ignoring string
 * literals).
 */
function findMatchingClose(src: string, openOffset: number): number {
  const len = src.length
  let depth = 0
  let i = openOffset
  let inStr: '"' | "'" | "`" | null = null
  while (i < len) {
    const c = src[i]!
    if (inStr) {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c as '"' | "'" | "`"
      i++
      continue
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++
    } else if (c === ")" || c === "}" || c === "]") {
      depth--
      if (depth === 0 && c === ")") return i
    }
    i++
  }
  return len - 1
}

// ── Scanning ─────────────────────────────────────────────────────────────

interface CallSite {
  readonly file: string
  readonly line: number
  readonly callExpression: string
  readonly hasAuditSink: boolean
  readonly argsSnippet: string
}

function scanForWrapperCalls(): CallSite[] {
  const sites: CallSite[] = []
  for (const scanDir of SCAN_DIRS) {
    const absDir = join(REPO_ROOT, scanDir)
    const files = walkTs(absDir)
    for (const file of files) {
      const rel = relative(REPO_ROOT, file)
      if (WRAPPER_DEFINITION_FILES.has(rel)) continue
      const raw = readFileSync(file, "utf8")
      const stripped = stripComments(raw)
      WRAPPER_CALL_PATTERN.lastIndex = 0
      for (const m of stripped.matchAll(WRAPPER_CALL_PATTERN)) {
        if (m.index === undefined) continue
        const callExpression = m[1] ?? ""
        // Skip import / export / type-only lines.
        const lineStart = stripped.lastIndexOf("\n", m.index) + 1
        const lineUpToMatch = stripped.slice(lineStart, m.index)
        if (/\bimport\b/.test(lineUpToMatch)) continue
        const lineEnd = stripped.indexOf("\n", m.index)
        const callLine = stripped.slice(
          lineStart,
          lineEnd === -1 ? stripped.length : lineEnd,
        )
        if (/\bexport\b/.test(callLine) || /\btype\b\s+\w+\s*=/.test(callLine)) {
          continue
        }
        // Open paren is at m.index + m[0].length - 1.
        const openOffset = m.index + m[0].length - 1
        const closeOffset = findMatchingClose(stripped, openOffset)
        const argBlock = stripped.slice(openOffset, closeOffset + 1)
        // Accept `auditSink: ...` OR `auditSink,` (shorthand property).
        // Spread (`...meta`) is NOT accepted — a site using spread MUST
        // be explicitly recognised here (no allowlist today; if one
        // becomes necessary, mirror T7's BEST_EFFORT_DEDUP_ALLOWLIST
        // pattern with rationale comments).
        const hasAuditSink = /\bauditSink\s*[:,}]/.test(argBlock)
        const line = stripped.slice(0, m.index).split("\n").length
        const argsSnippet = raw
          .slice(openOffset, Math.min(closeOffset + 1, openOffset + 240))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)
        sites.push({
          file: rel,
          line,
          callExpression,
          hasAuditSink,
          argsSnippet,
        })
      }
    }
  }
  return sites
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("audit-2026-05-24 T2 — AuditSink wrapper-call conformance", () => {
  // Cache the scan output across tests — the scan is O(N) over the source
  // tree and we run several assertions against it.
  const sites = scanForWrapperCalls()

  it("every wrapper call site supplies `auditSink` in its meta literal", () => {
    const violations: CallSite[] = []
    for (const site of sites) {
      if (site.hasAuditSink) continue
      violations.push(site)
    }
    if (violations.length > 0) {
      const lines = violations
        .map(
          (v) =>
            `  • ${v.file}:${v.line}  →  ${v.callExpression}(...) \n      ${v.argsSnippet}`,
        )
        .join("\n")
      throw new Error(
        `audit-2026-05-24 T2 — wrapper call site missing \`auditSink\`.\n\n` +
          `Per H2 §A1 (docs/adjudicate-migration/audit-2026-05-24/tasks/` +
          `h2-wrapper-audit-sink-architecture.md), every call to ` +
          `medusaAdjudicated / medusaStoreAdjudicated / stripeAdjudicated / ` +
          `twilioAdjudicated MUST pass \`auditSink: getAuditSink()\` from ` +
          `\`@ibatexas/audit-sink\`.\n\n` +
          `The wrapper meta type now REQUIRES \`auditSink\` at the type ` +
          `level (the conditional \`if (meta.auditSink)\` guard inside the ` +
          `wrapper body was removed in H2d). This static-grep is belt-and-` +
          `suspenders — it catches regressions if a future refactor flips ` +
          `the meta back to optional.\n\n` +
          `New violations (${violations.length}):\n${lines}\n\n` +
          `To fix: import \`getAuditSink\` from \`@ibatexas/audit-sink\` and ` +
          `add \`auditSink: getAuditSink()\` to the meta object literal at ` +
          `each call site. The leaf is fail-closed — \`getAuditSink()\` ` +
          `throws \`AuditSinkNotInitializedError\` if called before ` +
          `\`__setAuditSinkDependencies(...)\` runs at app boot ` +
          `(apps/api/src/audit-sink-bootstrap.ts).`,
      )
    }
    expect(violations).toEqual([])
  })

  it("scan picks up at least one call site per governed wrapper (smoke test)", () => {
    // Defensive — if the scan returns zero results for any of the 4
    // governed wrappers, either the wrapper was deleted (unlikely) or
    // the regex broke. Catch silent scan failures with a smoke check.
    const wrapperPrefixes = [
      "medusaStoreAdjudicated",
      "medusaAdjudicated",
      "stripeAdjudicated",
      "twilioAdjudicated",
    ]
    const missing: string[] = []
    for (const prefix of wrapperPrefixes) {
      const found = sites.some((s) => s.callExpression.startsWith(prefix))
      if (!found) missing.push(prefix)
    }
    if (missing.length > 0) {
      throw new Error(
        `Scan returned ZERO call sites for the following wrappers:\n` +
          missing.map((m) => `  • ${m}`).join("\n") +
          `\n\nEither the wrappers were removed (unlikely) OR the ` +
          `WRAPPER_CALL_PATTERN regex broke. Inspect the regex source.`,
      )
    }
    expect(missing).toEqual([])
  })

  it("scan picks up at least 30 wrapper-call sites (regression sentinel)", () => {
    // H2 task file enumerated 28 wrapper-call sites in production code
    // outside the wrapper definitions; the 18 already-passing sites in
    // apps/api/src/routes/* are also picked up. The exact count includes
    // the test's WRAPPER_DEFINITION_FILES exclusion + various refactors
    // (e.g. some "1 call" in the inventory is now folded into the
    // _shared.ts factory closure) so the floor is set looser than the
    // raw 28+18=46.
    //
    // If the count drops below 30, either a wrapper-call site was
    // removed (verify it was migrated to a kernel-direct path) OR the
    // regex stopped matching one of the shapes. Investigate before
    // relaxing this floor.
    const total = sites.length
    if (total < 30) {
      throw new Error(
        `Scan returned only ${total} wrapper-call sites — expected at ` +
          `least 30 (regression sentinel covering the H2 inventory + the ` +
          `already-passing apps/api/src/routes/* sites).\n\n` +
          `Either a major refactor removed wrapper-call sites OR the ` +
          `WRAPPER_CALL_PATTERN regex broke. Investigate before allowing ` +
          `this test to relax the floor.`,
      )
    }
    expect(total).toBeGreaterThanOrEqual(30)
  })

  it("scan completes in under 1 second (perf sentinel)", () => {
    // This conformance test must stay fast — it runs on every CI build.
    // The static scan over a few thousand files should complete in well
    // under a second. If this fails, the regex got pathological or the
    // scan surface grew unboundedly.
    const t0 = Date.now()
    scanForWrapperCalls()
    const elapsedMs = Date.now() - t0
    expect(elapsedMs).toBeLessThan(1000)
  })

  it("negative test — a synthetic call site without auditSink IS flagged", () => {
    // Pin the regex contract with a positive-flag test. If the regex
    // stops detecting "no auditSink", the conformance test silently
    // passes false-negatives.
    const synthetic = `await medusaAdjudicated({\n  scope: "store",\n  method: "POST",\n  path: "/x",\n  sourceSubject: "test",\n})`
    WRAPPER_CALL_PATTERN.lastIndex = 0
    const match = WRAPPER_CALL_PATTERN.exec(synthetic)
    expect(match).not.toBeNull()
    if (match) {
      const openOffset = match.index + match[0].length - 1
      const closeOffset = findMatchingClose(synthetic, openOffset)
      const argBlock = synthetic.slice(openOffset, closeOffset + 1)
      expect(/\bauditSink\s*[:,}]/.test(argBlock)).toBe(false)
    }
  })

  it("negative test — a synthetic call site WITH auditSink is NOT flagged", () => {
    // The mirror of the previous test — verify the positive path.
    const synthetic = `await medusaAdjudicated({\n  scope: "store",\n  method: "POST",\n  path: "/x",\n  sourceSubject: "test",\n  auditSink: getAuditSink(),\n})`
    WRAPPER_CALL_PATTERN.lastIndex = 0
    const match = WRAPPER_CALL_PATTERN.exec(synthetic)
    expect(match).not.toBeNull()
    if (match) {
      const openOffset = match.index + match[0].length - 1
      const closeOffset = findMatchingClose(synthetic, openOffset)
      const argBlock = synthetic.slice(openOffset, closeOffset + 1)
      expect(/\bauditSink\s*[:,}]/.test(argBlock)).toBe(true)
    }
  })
})
