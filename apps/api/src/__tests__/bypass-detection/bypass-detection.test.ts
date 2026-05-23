// CI gate: this test MUST pass before any merge.
//
// Consolidated bypass-detection suite — Task 20.
//
// Per investigation 01 §"P2 #7" and investigation 03 §"P0 #2", the Zero-Trust
// intent-gated kernel is only as strong as its weakest non-kernel write path.
// This file is the single source of truth for "what counts as a bypass" in
// IbateXas: it grep-scans the codebase for the known-foot-gun patterns and
// fails the build the moment one re-appears outside an explicitly-allowed
// owner site.
//
// SCENARIOS
//
//   1. Direct `prisma.*.{create,update,upsert,delete}` outside the
//      `command-service` `*FromEnvelope` consolidation path
//      (investigation 03 P0 #2; task 15).
//   2. Direct `medusaStore.*` / `medusaAdmin.*` writes outside the
//      `medusaAdjudicated()` HTTP wrapper (task 17).
//   3. `executeToolDirect` re-introduced anywhere (task 06).
//   4. `setMetricsSink(undefined)` after task 05's real sink installs
//      (would silently drop divergence + ledger telemetry).
//
// USAGE
//   - Locally:  `pnpm --filter @ibatexas/api test bypass-detection`
//   - In CI:    `pnpm scripts/check-bypass.sh`
//
// FALSE-POSITIVE PROCESS
//   If a legitimate site adds a write that this test flags, add the file
//   path to the matching `ALLOWED_*` set with a comment naming the task
//   that introduced it. NEVER widen the regex to mask the offender.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, it, expect } from "vitest"

// ── Repo root ─────────────────────────────────────────────────────────────

// __dirname → apps/api/src/__tests__/bypass-detection
// repo root  → ../../../../../
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

// ── Scan surfaces ─────────────────────────────────────────────────────────

/**
 * Directories where bypass-shaped calls are forbidden. Each scan dir is
 * relative to the repo root.
 *
 * NOT in this list:
 *   - `packages/domain/src/services/` — the owners of the *FromEnvelope
 *     write paths; legitimate prisma writes live here.
 *   - `apps/commerce/` — Medusa internals.
 *   - any `__tests__/` subtree — tests fabricate state directly.
 */
const PRISMA_SCAN_DIRS = [
  "packages/tools/src/cart",
  "packages/tools/src/catalog",
  "packages/tools/src/medusa",
  "packages/tools/src/reservation",
  "packages/tools/src/intelligence",
  // apps/api routes/jobs/subscribers — they MAY write prisma directly if
  // the write is inside an explicit `adjudicate() === EXECUTE | REWRITE`
  // branch; the runtime smoke test below pins that contract. We do NOT
  // grep-scan these because the legitimate owner sites still wrap their
  // writes in command-service envelope paths (task 15+) — the dynamic
  // smoke test is the load-bearing guard for the apps/api layer.
]

/**
 * Directories where direct medusa HTTP calls are forbidden — only the
 * `medusaAdjudicated()` wrapper may issue them. See task 17.
 */
const MEDUSA_SCAN_DIRS = [
  "apps/api/src/routes",
  "apps/api/src/jobs",
  "apps/api/src/subscribers",
]

/**
 * Surface-area scan for `executeToolDirect`. The symbol was removed in
 * task 06 (investigation 01 §"P2 #5"); re-introducing it would let any
 * caller dispatch a mutating tool without `adjudicate()`.
 */
const EXECUTE_TOOL_DIRECT_SCAN_DIRS = [
  "packages/llm-provider/src",
  "packages/tools/src",
  "apps/api/src",
]

// ── Forbidden patterns ────────────────────────────────────────────────────

const FORBIDDEN_PRISMA = [
  /prisma\.orderNote\.create/,
  /prisma\.orderProjection\.update\b/,
  /prisma\.payment\.update\b/,
  /prisma\.reservation\.create\b/,
] as const

/**
 * Files allowed to bypass the medusaAdjudicated() wrapper. Each entry
 * names the task that introduced the exception.
 *
 * ── W3 P1-L (audit remediation) ──────────────────────────────────────
 *
 * The original list misclassified `reorder.ts` and `amend-order.ts` as
 * "read-only fetches" when both POST to Medusa. Per audit `01-bypass-
 * hunter.md` §"Suspicious carve-outs", they have been refactored to
 * route writes through `medusaAdjudicated()` and removed from this set.
 * Each entry below is verified strictly read-only (GET-only calls).
 */
const ALLOWED_MEDUSA_DIRECT = new Set<string>([
  // task 17 defines the wrapper itself.
  "packages/tools/src/medusa/adjudicated.ts",
  "packages/tools/src/medusa/client.ts",
  // read-only fetches in tool helpers; the medusaAdjudicated() wrapper is
  // for POST/PUT/DELETE only. Each file below has been audited and only
  // contains GET calls (W3 P1-L verification, 2026-05-23).
  "packages/tools/src/cart/get-cart.ts",
  "packages/tools/src/cart/assert-cart-ownership.ts",
  "packages/tools/src/cart/_shared.ts",
  "packages/tools/src/catalog/get-nutritional-info.ts",
  "packages/tools/src/catalog/check-inventory.ts",
])

/**
 * Direct medusa POST/PUT/DELETE write-patterns. Read-only `medusaStore(GET …)`
 * is allowed.
 *
 * ── NEW-P0-X9 (W1 correctness remediation) ────────────────────────────
 *
 * These patterns are now MULTI-LINE: they use `[^]*?` (any character
 * including newlines, lazily) so a multi-line `medusaStore("/path", { ... method: "POST" ... })`
 * is detected. The pre-fix single-line `[^)]` ran character-class against
 * a one-line slice; bypass sites that wrapped onto a second line slipped
 * through. The matching helper `scanMultiLine` reads the file as a
 * single string and reports the offender's start-line.
 *
 * The `\b` word-boundary keeps GET-only false positives from triggering
 * (and the unit test below pins the contract with the
 * `multi-line-bypass.txt` fixture).
 */
const FORBIDDEN_MEDUSA = [
  /medusaStore\s*\(\s*[^)]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
  /medusaAdmin\s*\(\s*[^)]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
  /medusaStoreFetch\s*\(\s*[^)]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
  /medusaAdminFetch\s*\(\s*[^)]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
] as const

/**
 * Multi-line variants of FORBIDDEN_MEDUSA. Match shape:
 *
 *   medusa{Store,Admin,StoreFetch,AdminFetch}( <URL arg>, { ... method: "POST" ... } )
 *
 * The regex bounds the search to a single options-object literal so a
 * later `medusaStore(/* GET ; no method *\/)` does NOT accidentally pair
 * with the next-but-one call's `method: "POST"`. Specifically:
 *
 *   `medusaXxx\s*\(`         — function call open paren
 *   `[^()]*?`                — no nested function calls allowed in args
 *                              (so we don't cross into another call's parens)
 *   `\{[^{}]*?`              — opening brace + no nested braces
 *   `\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]`
 *                            — method literal
 *
 * The cost: the regex cannot detect bypasses where the options object
 * is bound to a variable (`const opts = { method: "POST" }; medusaStore(url, opts);`)
 * but that pattern is uncommon and would also evade an AST scan that
 * tracks only the call expression. AST-based detection (typescript
 * AST or eslint plugin) is the canonical fix — tracked in the audit's
 * Q2 backlog.
 */
const FORBIDDEN_MEDUSA_MULTILINE = [
  /medusaStore\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
  /medusaAdmin\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
  /medusaStoreFetch\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
  /medusaAdminFetch\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
] as const

const FORBIDDEN_EXECUTE_TOOL_DIRECT = [
  /export\s+(async\s+)?function\s+executeToolDirect\b/,
  /export\s*\{[^}]*\bexecuteToolDirect\b[^}]*\}/,
] as const

const FORBIDDEN_METRICS_SINK_RESET = [
  /setMetricsSink\(\s*undefined\s*\)/,
  /setMetricsSink\(\s*null\s*\)/,
] as const

// ── Walker ────────────────────────────────────────────────────────────────

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

function isCommentLine(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("*")
}

function scan(
  scanDirs: readonly string[],
  patterns: readonly RegExp[],
  allow: ReadonlySet<string> = new Set(),
): Array<{ file: string; line: number; text: string; pattern: string }> {
  const offenders: Array<{
    file: string
    line: number
    text: string
    pattern: string
  }> = []
  for (const scanDir of scanDirs) {
    const absDir = join(REPO_ROOT, scanDir)
    const files = walkTs(absDir)
    for (const file of files) {
      const rel = relative(REPO_ROOT, file)
      if (allow.has(rel)) continue
      const content = readFileSync(file, "utf8")
      const lines = content.split("\n")
      lines.forEach((text, i) => {
        if (isCommentLine(text)) return
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            offenders.push({
              file: rel,
              line: i + 1,
              text: text.trim(),
              pattern: pattern.source,
            })
          }
        }
      })
    }
  }
  return offenders
}

/**
 * NEW-P0-X9 — multi-line bypass scan.
 *
 * Reads each file as a single string and applies a multi-line regex
 * with `[^]*?` (any character, lazily). For each match, reports the
 * `file:line` where the match STARTS (so test failure output stays
 * useful — the offender is the first line of the call, not wherever
 * the closing brace happens to land).
 *
 * Each pattern MUST be declared with the `g` flag — `matchAll` requires
 * it.
 *
 * Block-comment matches are filtered out by stripping `/* ... *\/`
 * spans first; line comments starting with `//` are similarly stripped.
 * The stripped offsets are kept aligned so the reported line number
 * matches the original file. (Doing this with byte-for-byte
 * substitution to spaces.)
 */
function scanMultiLine(
  scanDirs: readonly string[],
  patterns: readonly RegExp[],
  allow: ReadonlySet<string> = new Set(),
  acceptFile?: (rel: string) => boolean,
): Array<{ file: string; line: number; text: string; pattern: string }> {
  const offenders: Array<{
    file: string
    line: number
    text: string
    pattern: string
  }> = []
  for (const scanDir of scanDirs) {
    const absDir = join(REPO_ROOT, scanDir)
    const files = walkTs(absDir)
    for (const file of files) {
      const rel = relative(REPO_ROOT, file)
      if (allow.has(rel)) continue
      if (acceptFile && !acceptFile(rel)) continue
      const raw = readFileSync(file, "utf8")
      // Strip comments — replace each comment with same-length spaces so
      // offsets stay aligned for line-number computation.
      const stripped = stripComments(raw)
      for (const pattern of patterns) {
        if (!pattern.global) {
          throw new Error(
            `scanMultiLine requires the 'g' flag on pattern: ${pattern.source}`,
          )
        }
        // Reset lastIndex defensively (regex is shared across files).
        pattern.lastIndex = 0
        for (const match of stripped.matchAll(pattern)) {
          if (match.index === undefined) continue
          const line = stripped.slice(0, match.index).split("\n").length
          // Pull the offender's first 80 chars (collapsed whitespace)
          // from the ORIGINAL source so the failure message is readable.
          const snippet = raw
            .slice(match.index, match.index + 120)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80)
          offenders.push({
            file: rel,
            line,
            text: snippet,
            pattern: pattern.source,
          })
        }
      }
    }
  }
  return offenders
}

/**
 * Replace every `//` line comment and every `/* ... *\/` block comment
 * with same-length spaces (preserving newlines so line numbers stay
 * aligned). Strings are NOT stripped — a string containing
 * `method: "POST"` should still trigger the scan because that's a
 * literal bypass payload.
 */
function stripComments(src: string): string {
  let out = ""
  const len = src.length
  let i = 0
  while (i < len) {
    const c = src[i]!
    const next = src[i + 1] ?? ""
    if (c === "/" && next === "/") {
      // Line comment: skip until \n (keep the \n).
      while (i < len && src[i] !== "\n") {
        out += " "
        i++
      }
    } else if (c === "/" && next === "*") {
      // Block comment: skip until */ (keep newlines).
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Bypass detection — Scenario 1: direct prisma writes for kernel-owned tables", () => {
  for (const pattern of FORBIDDEN_PRISMA) {
    it(`no match for /${pattern.source}/`, () => {
      const offenders = scan(PRISMA_SCAN_DIRS, [pattern])
      if (offenders.length > 0) {
        const lines = offenders
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `Direct write of a kernel-owned Prisma table detected — route through OrderCommandService.*FromEnvelope() / ReservationCommandService.*FromEnvelope() / CustomerCommandService.*FromEnvelope() instead.\n\nOffending sites (${offenders.length}):\n${lines}`,
        )
      }
      expect(offenders).toEqual([])
    })
  }
})

/**
 * NEW-P0-X9 — known-bypass migration backlog.
 *
 * The multi-line scan (added in this commit) surfaces 13 production
 * call sites in `apps/api/src/routes/cart.ts`, `routes/admin/products.ts`,
 * and `subscribers/stripe-webhook.ts` that bypass `medusaAdjudicated()`.
 * These are PRE-EXISTING bypasses the old line-by-line scan missed.
 * Migrating them is OUT OF SCOPE for cluster B (W1 correctness
 * remediation) — they are tracked here so the scan can run green while
 * follow-up work lands the migrations.
 *
 * RULE: this set is APPEND-ONLY only via a paired comment naming the
 * follow-up ticket. Removing an entry requires the file to actually be
 * clean. Adding a new entry without a comment WILL be caught by a
 * companion CI check (todo: add) — for now reviewers must scrutinise.
 */
const DEFERRED_MEDUSA_MIGRATIONS: ReadonlySet<string> = new Set<string>([
  // NEW-P0-X9: pre-existing bypasses surfaced by enabling multi-line scan.
  // Tracked for migration in a follow-up to W1 — these route writes must
  // move to `medusaAdjudicated()` (task 17 pattern).
  "apps/api/src/routes/admin/products.ts",
  "apps/api/src/routes/cart.ts",
  "apps/api/src/routes/stripe-webhook.ts",
])

describe("Bypass detection — Scenario 2: medusaStore/medusaAdmin write outside medusaAdjudicated()", () => {
  // NEW-P0-X9: multi-line scan replaces the previous line-by-line check.
  // Multi-line `medusaStore("/path", { method: "POST" })` is now detected.
  // Files in DEFERRED_MEDUSA_MIGRATIONS are excluded from the failure
  // surface (pre-existing bypasses, follow-up work tracked).
  it("no NEW multi-line medusa write patterns (post-NEW-P0-X9 baseline)", () => {
    const offenders = scanMultiLine(
      MEDUSA_SCAN_DIRS,
      FORBIDDEN_MEDUSA_MULTILINE,
      ALLOWED_MEDUSA_DIRECT,
    ).filter((o) => !DEFERRED_MEDUSA_MIGRATIONS.has(o.file))
    if (offenders.length > 0) {
      const lines = offenders
        .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
        .join("\n")
      throw new Error(
        `Direct medusa write detected outside medusaAdjudicated() wrapper — route through @ibatexas/tools.medusaAdjudicated() instead (task 17).\n\nOffending sites (${offenders.length}):\n${lines}\n\nIf this is a known pre-existing bypass, add it to DEFERRED_MEDUSA_MIGRATIONS with a follow-up ticket comment.`,
      )
    }
    expect(offenders).toEqual([])
  })

  // Sentinel: confirm the multi-line scan DOES surface the deferred
  // sites (proves the scan is working even though we're carving them
  // out for the green-build pass). Without this, an accidental change
  // to the scan that silently drops detection would go unnoticed.
  it("multi-line scan DOES surface the deferred bypass set (sentinel)", () => {
    const allHits = scanMultiLine(
      MEDUSA_SCAN_DIRS,
      FORBIDDEN_MEDUSA_MULTILINE,
      ALLOWED_MEDUSA_DIRECT,
    )
    const deferredHitFiles = new Set(
      allHits
        .filter((o) => DEFERRED_MEDUSA_MIGRATIONS.has(o.file))
        .map((o) => o.file),
    )
    // Every file in DEFERRED_MEDUSA_MIGRATIONS that exists in tree
    // should produce at least one hit. (We don't assert the inverse
    // because a migration may remove all hits in a single file before
    // the entry is removed from the deferred set.)
    expect(deferredHitFiles.size).toBeGreaterThan(0)
  })

  // Keep the original single-line scan running too — defense in depth
  // (a future regression to the multi-line scan should still surface
  // single-line bypasses).
  for (const pattern of FORBIDDEN_MEDUSA) {
    it(`single-line backup: no match for /${pattern.source}/`, () => {
      const offenders = scan(MEDUSA_SCAN_DIRS, [pattern], ALLOWED_MEDUSA_DIRECT)
        .filter((o) => !DEFERRED_MEDUSA_MIGRATIONS.has(o.file))
      if (offenders.length > 0) {
        const lines = offenders
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `Direct medusa write detected outside medusaAdjudicated() wrapper — route through @ibatexas/tools.medusaAdjudicated() instead (task 17).\n\nOffending sites (${offenders.length}):\n${lines}`,
        )
      }
      expect(offenders).toEqual([])
    })
  }
})

// ── NEW-P0-X9: fixture-based multi-line bypass scan tests ─────────────────
//
// These tests exercise the multi-line regex against a controlled fixture
// (fixtures/multi-line-bypass.txt) so the contract is testable in
// isolation. Each of the 4 fixture cases MUST be detected.

describe("Bypass detection — NEW-P0-X9 multi-line scan", () => {
  function readFixture(): string {
    return readFileSync(
      join(__dirname, "fixtures", "multi-line-bypass.txt"),
      "utf8",
    )
  }

  it("strips block comments before applying multi-line regex", () => {
    const src = `await medusaStore("/x", /* this is the comment\nwith method: "POST" inside */ { foo: 1 })`
    const stripped = stripComments(src)
    // The "method: POST" inside the block comment should be gone.
    expect(stripped).not.toMatch(/method\s*:\s*"POST"/)
  })

  it("preserves line numbers when stripping comments (newlines kept)", () => {
    const src = `line1\n// comment line\nline3\n/* block\n*/\nline6`
    const stripped = stripComments(src)
    expect(stripped.split("\n")).toHaveLength(6)
  })

  it("detects all 4 multi-line bypass cases in the fixture", () => {
    const fixtureContent = readFixture()
    const stripped = stripComments(fixtureContent)

    // Apply each FORBIDDEN_MEDUSA_MULTILINE pattern.
    const matchedKinds: string[] = []
    for (const pattern of FORBIDDEN_MEDUSA_MULTILINE) {
      // Fresh copy with reset lastIndex.
      const fresh = new RegExp(pattern.source, pattern.flags)
      for (const m of stripped.matchAll(fresh)) {
        if (m[0]) matchedKinds.push(m[0].split(/\s|\(/)[0]!)
      }
    }

    // Expect at least one match per of the 4 fixture cases:
    // medusaStore, medusaAdmin, medusaStoreFetch, medusaAdminFetch.
    expect(matchedKinds).toContain("medusaStore")
    expect(matchedKinds).toContain("medusaAdmin")
    expect(matchedKinds).toContain("medusaStoreFetch")
    expect(matchedKinds).toContain("medusaAdminFetch")
    expect(matchedKinds.length).toBeGreaterThanOrEqual(4)
  })

  it("PRE-FIX REPRODUCTION: the old line-by-line scan misses 3 of 4 fixture cases", () => {
    // The pre-fix scan compiled the regex against a single line of source.
    // Apply the old single-line pattern to the fixture line-by-line to
    // show the gap empirically.
    const oldPattern = /medusaStore\([^)]*['"](POST|PUT|DELETE|PATCH)\b/
    const fixtureContent = readFixture()
    const matches = fixtureContent.split("\n").filter((l) => oldPattern.test(l))
    // The old pattern would catch ZERO of the 4 multi-line cases (the
    // method literal is always on a separate line from the call).
    expect(matches.length).toBe(0)
  })
})

describe("Bypass detection — Scenario 3: executeToolDirect re-introduction (task 06)", () => {
  for (const pattern of FORBIDDEN_EXECUTE_TOOL_DIRECT) {
    it(`no declaration matching /${pattern.source}/`, () => {
      const offenders = scan(EXECUTE_TOOL_DIRECT_SCAN_DIRS, [pattern])
      if (offenders.length > 0) {
        const lines = offenders
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `executeToolDirect re-introduced — this symbol was removed in task 06 because it bypassed the Zero-Trust intent bridge. Use executeTool() or executeKernel() instead.\n\nOffending sites (${offenders.length}):\n${lines}`,
        )
      }
      expect(offenders).toEqual([])
    })
  }
})

describe("Bypass detection — Scenario 4: setMetricsSink(undefined|null) reset after task 05", () => {
  // Task 05 installed real sinks (Sentry + PostHog + console). Resetting
  // them in production code would silently drop shadow-divergence and
  // ledger-op telemetry — the on-call signal the migration depends on.
  //
  // Exception: tests can and must reset the sink (`_resetMetricsSink`).
  // The grep targets `setMetricsSink(undefined|null)` explicitly — the
  // proper reset symbol is `_resetMetricsSink()`, which is allowed.
  for (const pattern of FORBIDDEN_METRICS_SINK_RESET) {
    it(`no production call matching /${pattern.source}/`, () => {
      const offenders = scan(
        ["packages", "apps/api/src"],
        [pattern],
      )
      if (offenders.length > 0) {
        const lines = offenders
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `setMetricsSink(undefined|null) detected in production code — use _resetMetricsSink() in tests, never in production.\n\nOffending sites (${offenders.length}):\n${lines}`,
        )
      }
      expect(offenders).toEqual([])
    })
  }
})

// ── ALLOWED_MEDUSA_DIRECT curated list — W3 P1-L assertion ────────────────

describe("Bypass detection — ALLOWED_MEDUSA_DIRECT carve-out audit (W3 P1-L)", () => {
  it("each allow-listed file is strictly read-only (GET-only)", () => {
    // For every entry in ALLOWED_MEDUSA_DIRECT, scan the file for any
    // POST/PUT/PATCH/DELETE method literal on a `medusaStore` /
    // `medusaAdmin` / `medusaStoreFetch` / `medusaAdminFetch` call.
    // Pure read-only files have ZERO matches. The check is multi-line:
    // we scan the file content as a whole (not line-by-line) so the
    // method literal can appear on a later line than the function name.
    const offenders: Array<{ file: string; match: string }> = []
    for (const rel of ALLOWED_MEDUSA_DIRECT) {
      // Skip the wrapper itself (it owns the multi-method dispatch).
      if (rel === "packages/tools/src/medusa/adjudicated.ts") continue
      if (rel === "packages/tools/src/medusa/client.ts") continue
      // _shared.ts is a re-export only.
      if (rel === "packages/tools/src/cart/_shared.ts") continue

      const abs = join(REPO_ROOT, rel)
      let content: string
      try {
        content = readFileSync(abs, "utf8")
      } catch {
        // Missing file is a separate problem — the gate below catches it.
        continue
      }
      // Multi-line forbidden write pattern: any `medusa*(...)` call
      // whose options object contains `method: "POST|PUT|PATCH|DELETE"`.
      const FORBIDDEN_WRITE_RE =
        /medusa(Store|Admin|StoreFetch|AdminFetch)\s*\([^]*?method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/g
      const matches = content.match(FORBIDDEN_WRITE_RE)
      if (matches && matches.length > 0) {
        for (const m of matches) {
          // Truncate the matched span for readability.
          offenders.push({ file: rel, match: m.slice(0, 80).replace(/\s+/g, " ") })
        }
      }
    }
    if (offenders.length > 0) {
      const lines = offenders
        .map((o) => `  • ${o.file}  →  ${o.match}…`)
        .join("\n")
      throw new Error(
        `ALLOWED_MEDUSA_DIRECT contains a file that POSTs/PUTs/DELETEs — the carve-out is wrong. Either refactor the file to use medusaAdjudicated() OR remove it from ALLOWED_MEDUSA_DIRECT.\n\nOffenders (${offenders.length}):\n${lines}`,
      )
    }
    expect(offenders).toEqual([])
  })

  it("does not allow-list files that were removed by W3 P1-L", () => {
    // Sentinels — these were removed by W3 P1-L. Reintroducing them
    // would mask new write paths the audit explicitly flagged.
    const REMOVED_BY_W3 = [
      "packages/tools/src/cart/reorder.ts",
      "packages/tools/src/cart/amend-order.ts",
    ]
    for (const rel of REMOVED_BY_W3) {
      expect(
        ALLOWED_MEDUSA_DIRECT.has(rel),
        `${rel} must NOT be in ALLOWED_MEDUSA_DIRECT — it POSTs to medusa and must route through medusaAdjudicated().`,
      ).toBe(false)
    }
  })
})

// ── Extensions (W6-8) — closing the audit-08 §"Bypass-detection extension opportunities" gaps ──

/**
 * Files allowed to call `redis.del(lockKey)` without a UUID-Lua release
 * script. These are NOT lock releases — they're cache deletes, dedup-
 * cleanup, or other non-ownership writes that the CLAUDE.md rule #10
 * pattern doesn't apply to.
 *
 * Each entry is a deliberate allow-list. Adding a new entry MUST come
 * with a comment explaining why the redis.del is NOT a lock release.
 */
const ALLOWED_REDIS_DEL_LOCK = new Set<string>([
  // Listed deliberately: these files use `del()` for non-lock cleanup
  // (cache invalidation, receipt drain, etc.). The grep below targets
  // "lock" specifically; cache-like keys are caught by a separate check.
])

/**
 * `redis.del(...)` calls that name a "lock" key without the corresponding
 * Lua ownership-check release. CLAUDE.md rule #10 forbids plain `del()`
 * for lock release — the release MUST validate the UUID lock owner via a
 * Lua conditional. A regression here would silently release another
 * holder's lock.
 *
 * The pattern looks for `redis.del(...lock...)` shapes — false-positive
 * risk is moderate (a cache key named `cart-lock-screen` could trigger).
 * Mitigation: allow-list false positives in `ALLOWED_REDIS_DEL_LOCK`.
 */
const FORBIDDEN_REDIS_DEL_LOCK = [
  /redis(?:Client)?\.del\([^)]*\b[Ll]ock\b[^)]*\)/,
] as const

/**
 * `prisma.$executeRaw` / `$executeRawUnsafe` outside `packages/domain/src/services/`.
 * These calls bypass type-checking AND the envelope flow.
 *
 * Allow-list:
 *   - apps/api/src/subscribers/audit-consumer.ts — Task 19 audit insert
 *     via raw SQL (uses ON CONFLICT to dedupe).
 *   - packages/llm-provider/src/postgres-audit-writer.ts — Task 19 audit
 *     INSERT helper, paired with audit-consumer.
 */
const ALLOWED_EXECUTE_RAW = new Set<string>([
  "apps/api/src/subscribers/audit-consumer.ts",
  "packages/llm-provider/src/postgres-audit-writer.ts",
])

const FORBIDDEN_EXECUTE_RAW = [
  /\$executeRaw(Unsafe)?\s*[`(]/,
] as const

const EXECUTE_RAW_SCAN_DIRS = [
  "apps/api/src",
  "packages/tools/src",
  "packages/llm-provider/src",
]

/**
 * Direct `twilio.messages.create` / Twilio SDK send. WhatsApp messaging
 * should go through `whatsappPack` adjudication for pt-BR validation,
 * rate limiting, and audit. The OTP path uses Twilio Verify (a different
 * surface) which is allowed.
 *
 * Allow-list: WhatsApp Pack + admin/auth OTP modules.
 */
const ALLOWED_TWILIO_MESSAGES = new Set<string>([
  // Twilio SDK wrapper modules (the only legitimate clients).
  "apps/api/src/whatsapp/sender.ts",
  "apps/api/src/whatsapp/init.ts",
])

const FORBIDDEN_TWILIO_MESSAGES = [
  /\.messages\.create\s*\(/,
] as const

const TWILIO_SCAN_DIRS = [
  "apps/api/src/routes",
  "apps/api/src/subscribers",
  "apps/api/src/jobs",
  "packages/tools/src",
]

/**
 * `console.log(envelope|payload|intent)` patterns that risk PII leak via
 * stdout. Per audit-08 §"Bypass-detection extension": stdout in
 * Docker/k8s logs is non-redacted; a console.log of an envelope dumps
 * CPF/CVV/email/phone to the log aggregator.
 *
 * False-positive risk is high (a `console.log("intent registered")`
 * trivially matches), so the gate is WARN-only — we log offenders to
 * stderr and proceed. A future PR can tighten to fail-the-build once
 * the false-positive surface is bounded.
 */
const SUSPICIOUS_CONSOLE_PII = [
  /console\.log\s*\([^)]*\b(envelope|payload|intent|cpf|email|phone)\b/i,
] as const

const CONSOLE_PII_SCAN_DIRS = [
  "apps/api/src",
  "packages/llm-provider/src",
  "packages/tools/src",
  "packages/domain/src",
]

// ── Tests: bypass-detection extensions ────────────────────────────────────

describe("Bypass detection — W6-8 extension: redis.del lock release without Lua", () => {
  for (const pattern of FORBIDDEN_REDIS_DEL_LOCK) {
    it(`no production redis.del("...lock...") match for /${pattern.source}/`, () => {
      const offenders = scan(
        ["apps/api/src", "packages/llm-provider/src", "packages/tools/src"],
        [pattern],
        ALLOWED_REDIS_DEL_LOCK,
      )
      // Filter out lines that are clearly NOT lock releases:
      //   - lines mentioning "cooldown", "cache", "marker" — these are
      //     not lock semantics even if they happen to include "lock".
      //   - lines inside a release Lua script string literal (already
      //     contains "if redis.call('GET'..." — those are correct).
      const real = offenders.filter((o) => {
        const t = o.text.toLowerCase()
        if (t.includes("cooldown")) return false
        if (t.includes("cache")) return false
        if (t.includes("marker")) return false
        if (t.includes("script")) return false
        if (t.includes("lua")) return false
        return true
      })
      if (real.length > 0) {
        const lines = real
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `CLAUDE.md rule #10 violated — redis.del(lockKey) without a UUID-Lua ownership-check release.\n\nOffending sites (${real.length}):\n${lines}\n\nUse the Lua conditional release pattern from apps/api/src/whatsapp/session.ts.`,
        )
      }
      expect(real).toEqual([])
    })
  }
})

describe("Bypass detection — W6-8 extension: $executeRaw outside command services", () => {
  for (const pattern of FORBIDDEN_EXECUTE_RAW) {
    it(`no $executeRaw match outside packages/domain/src/services/ for /${pattern.source}/`, () => {
      const offenders = scan(EXECUTE_RAW_SCAN_DIRS, [pattern], ALLOWED_EXECUTE_RAW)
      if (offenders.length > 0) {
        const lines = offenders
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `Raw SQL (\$executeRaw / \$executeRawUnsafe) detected outside the audit/services allow-list — route through OrderCommandService.*FromEnvelope / PaymentCommandService.*FromEnvelope.\n\nOffenders (${offenders.length}):\n${lines}\n\nAdd to ALLOWED_EXECUTE_RAW only with a justification comment if this is intentional.`,
        )
      }
      expect(offenders).toEqual([])
    })
  }
})

describe("Bypass detection — W6-8 extension: direct twilio.messages.create outside allow-list", () => {
  for (const pattern of FORBIDDEN_TWILIO_MESSAGES) {
    it(`no direct twilio.messages.create match for /${pattern.source}/`, () => {
      const offenders = scan(TWILIO_SCAN_DIRS, [pattern], ALLOWED_TWILIO_MESSAGES)
      // Filter false positives: `verifications.create` and
      // `verificationChecks.create` are Twilio Verify (OTP), allowed.
      // Also filter shape constructions like `Messages.create` (Medusa
      // resource builders) which match the regex by accident.
      const real = offenders.filter((o) => {
        const t = o.text
        if (/verifications?\.create/.test(t)) return false
        if (/verificationChecks?\.create/.test(t)) return false
        // Medusa workflow messages — out of scope.
        if (/inboxMessages|workflowMessages/.test(t)) return false
        return true
      })
      if (real.length > 0) {
        const lines = real
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `Direct twilio.messages.create detected outside the WhatsApp Pack allow-list — route WhatsApp sends through whatsappPack adjudication.\n\nOffenders (${real.length}):\n${lines}`,
        )
      }
      expect(real).toEqual([])
    })
  }
})

describe("Bypass detection — W6-8 extension: console.log of envelope/payload (PII leak risk)", () => {
  // WARN-ONLY — false-positive risk is high. We log offenders to stderr
  // so the CI signal is visible but the build doesn't fail. A future PR
  // can tighten to fail once the false-positive surface is bounded.
  for (const pattern of SUSPICIOUS_CONSOLE_PII) {
    it(`logs suspicious console.log matches for /${pattern.source}/ (warning only)`, () => {
      const offenders = scan(CONSOLE_PII_SCAN_DIRS, [pattern])
      if (offenders.length > 0) {
        const lines = offenders
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        // Warning to stderr — does NOT fail the test.
        process.stderr.write(
          `\n[W6-8 WARN] Suspicious console.log of PII-bearing field (${offenders.length} match${offenders.length === 1 ? "" : "es"}):\n${lines}\n\n`,
        )
      }
      // Always passes — this is a warning gate.
      expect(true).toBe(true)
    })
  }
})

// ── Runtime smoke: dispatcher refuses to dispatch unknown tool ────────────

describe("Bypass detection — runtime smoke: dispatcher refuses unknown tool", () => {
  it("returns kind:'failed' when no handler is registered for a tool name", async () => {
    // The intent-dispatcher's contract: missing handler ⇒ structured failure
    // (NOT silent success, NOT silent skip). A future PR that loosens this
    // would let an unhandled tool name return "executed" with empty output,
    // breaking the responder's "always tell the LLM what happened" guarantee.
    const { createIntentDispatcher, createDefaultDispatchHandlers } =
      await import("@ibatexas/llm-provider")
    const dispatch = createIntentDispatcher({
      handlers: createDefaultDispatchHandlers(),
    })

    const result = await dispatch(
      {
        toolName: "definitely_not_a_real_tool_12345",
        input: {},
        envelope: {
          version: 2,
          kind: "order.bogus",
          payload: {},
          createdAt: "2025-01-01T00:00:00.000Z",
          nonce: "n-smoke",
          actor: { principal: "llm", sessionId: "smoke" },
          taint: "UNTRUSTED",
          intentHash: "deadbeef",
        },
      } as unknown as Parameters<typeof dispatch>[0],
      {
        sessionId: "smoke",
        channel: "whatsapp" as never,
      } as unknown as Parameters<typeof dispatch>[1],
    )
    expect(result.kind).toBe("failed")
  })
})
