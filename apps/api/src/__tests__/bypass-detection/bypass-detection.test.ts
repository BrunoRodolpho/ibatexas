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
 *
 * ── W8-V4 (NEW-W7-V4) ────────────────────────────────────────────────
 *
 * The W6 verifier surfaced the gap that the scan dirs only covered
 * apps/api/src and excluded packages/tools/src — the same dirs where
 * W6's "Stripe SDK direct calls: 6 sites" + "prisma.orderNote.create
 * in 4 production routes" findings lived. W7-P4 (orderNote) and
 * W7-P5 (stripe cart) closed those bypasses but did NOT widen the
 * scan, so a future regression in packages/tools/src/cart/ would not
 * surface in CI.
 *
 * W8-V4 widens MEDUSA_SCAN_DIRS to also cover packages/tools/src/.
 * Legitimate read-only carve-outs are listed in ALLOWED_MEDUSA_DIRECT
 * (e.g. cart/get-cart.ts, catalog/check-inventory.ts, the wrapper
 * itself), so adding the dirs widens detection without false positives.
 *
 * packages/domain/src/services/ is INTENTIONALLY NOT in this list —
 * the *FromEnvelope write paths and `mutate()` helper there are the
 * canonical owner sites for medusa egress; they don't make HTTP calls
 * (they delegate to medusaAdjudicated via the adminAdjudicated DI per
 * W7-P6 + W8-V1).
 */
const MEDUSA_SCAN_DIRS = [
  "apps/api/src/routes",
  "apps/api/src/jobs",
  "apps/api/src/subscribers",
  "packages/tools/src",
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
  // W9 — sibling STORE-scope wrapper. Itself dispatches to medusaStore
  // after kernel adjudication; the file's bare medusaStore(..., POST/DELETE)
  // invocations are the wrapper's own transport bridge and must not be
  // flagged by the bypass scanner. Sibling rationale to ./adjudicated.ts.
  "packages/tools/src/medusa/store-adjudicated.ts",
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
  // W7-G2: backtick added to the method-literal quote class. Wave 6 Target 8
  // demonstrated that `method: \`POST\`` (template literal) silently passed
  // every pre-G2 pattern because the quote class was `['"]` only. Widening
  // to `['"`]` closes the bypass without changing match semantics for the
  // single/double-quoted cases. The companion `template-literal-method.txt`
  // fixture pins this contract against future reverts.
  /medusaStore\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"`](POST|PUT|DELETE|PATCH)['"`]/g,
  /medusaAdmin\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"`](POST|PUT|DELETE|PATCH)['"`]/g,
  /medusaStoreFetch\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"`](POST|PUT|DELETE|PATCH)['"`]/g,
  /medusaAdminFetch\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"`](POST|PUT|DELETE|PATCH)['"`]/g,
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
 * Originally surfaced 13 production call sites in `routes/admin/products.ts`,
 * `routes/cart.ts`, and `routes/stripe-webhook.ts` that bypassed
 * `medusaAdjudicated()`. All 13 sites were migrated to the wrapper in
 * the P0-X9 follow-up commits.
 *
 * ── W8-V4 (NEW-W7-V4) additions ──────────────────────────────────────
 *
 * Widening MEDUSA_SCAN_DIRS to include `packages/tools/src/` surfaced
 * 10 store-scope `medusaStoreFetch` POST sites in cart tools that
 * were structurally invisible to CI before:
 *
 *   - add-to-cart, apply-coupon, remove-from-cart, update-cart,
 *     get-or-create-cart (5 line-item / cart-create POSTs)
 *   - create-checkout (5 POSTs across cart-set-email, promotions,
 *     payment-collections, payment-sessions, cart-complete)
 *
 * These are all customer-cart STORE-scope mutations (`/store/carts/...`
 * and `/store/payment-collections/...`) on the LLM-callable surface.
 * They're real bypasses — kernel adjudication and audit are skipped
 * today — but migrating them inline requires:
 *   (a) New `medusa.store.cart.*` intent kinds in the wrapper's
 *       MEDUSA_INTENT_KINDS taxonomy.
 *   (b) Per-kind policy bundle decisions (auth, taint, business).
 *   (c) Test coverage for the LLM-flow → kernel → SDK dispatch path.
 *
 * That work landed in the audit-2026-05-23 Wave 9 closeout: the
 * medusaStoreAdjudicated wrapper landed in commit `8653a13` and the 10
 * cart-store sites were migrated to it across commits in the same
 * branch (3 parallel migration agents per the wave-4 plan). The set
 * below is now empty in steady state.
 *
 * RULE: any future entry MUST come with a paired comment naming the
 * follow-up ticket. Removing an entry requires the file to actually be
 * clean (the main `no NEW multi-line medusa write patterns` test will
 * fail otherwise). Adding a new entry without a comment WILL be caught
 * by a companion CI check (todo: add) — for now reviewers must scrutinise.
 */
const DEFERRED_MEDUSA_MIGRATIONS: ReadonlySet<string> = new Set<string>([
  // empty — Wave 9 cart-egress migration is complete.
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

  // W8-V4 sentinel — the scan must not silently degrade. Two checks:
  //
  //   1. The fixture-based multi-line scan still detects 4-of-4 cases
  //      (covered by the "detects all 4 multi-line bypass cases" test
  //      below — pinned via the fixture, independent of production tree
  //      state).
  //   2. DEFERRED_MEDUSA_MIGRATIONS is empty in steady state. Post Wave 9
  //      cart-egress migration (medusaStoreAdjudicated wrapper at commit
  //      `8653a13` + 10 site migrations on the same branch), there are
  //      no known pending Medusa-write bypasses. Any new entry MUST be
  //      paired with a follow-up ticket comment in the set above.
  it("DEFERRED_MEDUSA_MIGRATIONS is empty in steady state (Wave 9 cart-egress closed)", () => {
    expect(DEFERRED_MEDUSA_MIGRATIONS.size).toBe(0)
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
    expect(matches).toHaveLength(0)
  })
})

// ── W7-G2: template-literal bypass detection ───────────────────────────────
//
// Wave 6 red-team Target 8 (apps/api/src/__tests__/wave6-red-team/
// 02-template-literal-bypass.test.ts) demonstrated that the
// FORBIDDEN_MEDUSA_MULTILINE patterns used `['"]` for the method-literal
// quote class, silently passing any developer who wrote
// `method: \`POST\`` (template literal) instead of `method: 'POST'`.
//
// W7-G2 widens the quote class to `['"\`]` in all four patterns. The
// fixture below contains the 4 backtick variants (one per medusa*
// function); the test asserts the post-fix regex catches all 4 AND
// re-derives the pre-fix gap empirically (zero matches with the old
// quote class).

describe("Bypass detection — W7-G2 template-literal multi-line scan", () => {
  function readTemplateFixture(): string {
    return readFileSync(
      join(__dirname, "fixtures", "template-literal-method.txt"),
      "utf8",
    )
  }

  it("detects all 4 backtick-method bypass cases in the template-literal fixture", () => {
    const fixtureContent = readTemplateFixture()
    const stripped = stripComments(fixtureContent)

    const matchedKinds: string[] = []
    for (const pattern of FORBIDDEN_MEDUSA_MULTILINE) {
      const fresh = new RegExp(pattern.source, pattern.flags)
      for (const m of stripped.matchAll(fresh)) {
        if (m[0]) matchedKinds.push(m[0].split(/\s|\(/)[0]!)
      }
    }

    expect(matchedKinds).toContain("medusaStore")
    expect(matchedKinds).toContain("medusaAdmin")
    expect(matchedKinds).toContain("medusaStoreFetch")
    expect(matchedKinds).toContain("medusaAdminFetch")
    expect(matchedKinds.length).toBeGreaterThanOrEqual(4)
  })

  it("PRE-FIX REPRODUCTION: a regex with only ['\"] quote class catches ZERO backtick cases", () => {
    // Re-create the pre-W7-G2 regex shape (no backtick in the quote class)
    // and apply it to the template-literal fixture. The point is to pin
    // the empirical bypass — if some future refactor were to drop the
    // backtick from the quote class, this assertion would surface it
    // alongside the positive check above.
    const preFixPattern =
      /medusaStore\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g
    const fixtureContent = readTemplateFixture()
    const matches = Array.from(fixtureContent.matchAll(preFixPattern))
    expect(matches).toHaveLength(0)
  })

  it("each FORBIDDEN_MEDUSA_MULTILINE pattern's quote class admits backticks", () => {
    // Defense-in-depth: walk the regex source strings directly and assert
    // they reference the backtick character in the method-quote position.
    // A future revert that drops the backtick from any of the 4 patterns
    // fails the build immediately.
    for (const pattern of FORBIDDEN_MEDUSA_MULTILINE) {
      // The post-W7-G2 quote class is `['"\`]` — assert the backtick is
      // present in the pattern source.
      expect(
        pattern.source,
        `pattern ${pattern.source} must include backtick in the method quote class`,
      ).toMatch(/\['"`\]/)
    }
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
 *   - apps/api/src/jobs/retention-cleaner.ts — responder-trace-admin C2: the
 *     turn_trace retention sweep. turn_trace is a TELEMETRY table (not a
 *     kernel-gated domain entity, not a Prisma model), so a time-based DELETE
 *     is a maintenance sweep that legitimately runs outside the envelope path —
 *     exactly like the conversationMessage/orderEventLog deleteMany purges in
 *     the same file. The DELETE is parameterized (tagged template), not Unsafe.
 */
const ALLOWED_EXECUTE_RAW = new Set<string>([
  "apps/api/src/subscribers/audit-consumer.ts",
  "packages/llm-provider/src/postgres-audit-writer.ts",
  "apps/api/src/jobs/retention-cleaner.ts",
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
 * should go through `twilioAdjudicated.messages.create()` (kernel-gated
 * egress wrapper in `@ibatexas/tools`) so each send produces an audit
 * record and the inline policy bundle governs egress. The OTP path uses
 * Twilio Verify (a different surface — `verifications.create` /
 * `verificationChecks.create`) which is filtered out by the test below.
 *
 * Allow-list: the wrapper itself.
 *
 * ── audit-2026-05-23 ─────────────────────────────────────────────────
 * The previous allowlist referenced `apps/api/src/whatsapp/sender.ts`
 * which never existed on disk (a real `packages/tools/src/whatsapp/
 * sender.ts` exists but is just a DI seam — no `messages.create`).
 * The 2× `messages.create` in `apps/api/src/whatsapp/client.ts` are
 * now routed through `twilioAdjudicated`; the scan covers
 * `apps/api/src/whatsapp` so any future regression at the bare-SDK
 * level surfaces. The wrapper file is the only legitimate site.
 */
const ALLOWED_TWILIO_MESSAGES = new Set<string>([
  // The kernel-gated wrapper itself (audit-2026-05-23).
  "packages/tools/src/twilio/adjudicated.ts",
])

const FORBIDDEN_TWILIO_MESSAGES = [
  /\.messages\.create\s*\(/,
] as const

const TWILIO_SCAN_DIRS = [
  "apps/api/src/routes",
  "apps/api/src/subscribers",
  "apps/api/src/jobs",
  "apps/api/src/whatsapp",
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
          `Raw SQL ($executeRaw / $executeRawUnsafe) detected outside the audit/services allow-list — route through OrderCommandService.*FromEnvelope / PaymentCommandService.*FromEnvelope.\n\nOffenders (${offenders.length}):\n${lines}\n\nAdd to ALLOWED_EXECUTE_RAW only with a justification comment if this is intentional.`,
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
        // audit-2026-05-23: `twilioAdjudicated.messages.create(...)` is
        // the kernel-gated wrapper call — that IS the legitimate egress
        // path. Only bare-SDK `client.messages.create` / `twilio.messages.create`
        // counts as a bypass.
        if (/twilioAdjudicated\.messages\.create/.test(t)) return false
        return true
      })
      if (real.length > 0) {
        const lines = real
          .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
          .join("\n")
        throw new Error(
          `Direct twilio.messages.create detected outside the WhatsApp Pack allow-list — route WhatsApp sends through twilioAdjudicated.messages.create() in @ibatexas/tools.\n\nOffenders (${real.length}):\n${lines}`,
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
      // Always passes — this is a warning gate. `offenders` is always an
      // array (scan() never returns null/undefined), so this assertion is
      // unconditionally satisfied just like the prior `true`/`true` check.
      expect(offenders).toBeDefined()
    })
  }
})

// ── W7-P2: DEFERRED_ADMIN_LOW_RISK allowlist (admin scheduler/tables/zones) ──
//
// Ten admin route call sites bypass the *FromEnvelope adjudication path
// because their underlying services (`schedule.service.ts`,
// `table.service.ts`, `delivery-zone.service.ts`) do NOT have *FromEnvelope
// methods today. W7-Govern-Admin chose path (b) over path (a) — see
// `docs/adjudicate-migration/correctness-remediation/W7-DECISIONS-admin.md`
// for the policy-blast / audit-trail / rollout-cost analysis.
//
// This allowlist is the declarative contract that says "we deliberately do
// NOT govern these 10 sites with the envelope flow; the trade-off is
// documented." A test below scans the 3 admin route files for bare
// `<svc>.<mutator>(...)` patterns and fails the build IF:
//
//   1. A bare-call pattern appears in one of the 3 files but is NOT
//      enumerated in DEFERRED_ADMIN_LOW_RISK (regression — a new bypass
//      surfaced without a paired deferral rationale).
//   2. An allowlist entry disappears from the source (silent allowlist
//      loss — an entry was deleted but the bare call was NOT replaced
//      with an envelope path; either fix the route to use the envelope
//      path OR drop the entry from the allowlist deliberately).
//
// The shape `{ file, pattern, rationale }` lets the test report the
// site-by-site rationale on failure and keeps the table machine-readable
// for a future migration audit (W8/W9 governance review).
//
// IMPORTANT: this is a code-shape grep, not a runtime gate. The actual
// admin route mutations still happen at runtime — they are just NOT
// wrapped in `adjudicate()`. The W7-DECISIONS-admin.md rationale spells
// out why that is acceptable for the 10 staff-only, operator-driven sites
// listed below.
//
// PROMOTION TRIGGER: see W7-DECISIONS-admin.md §"Follow-up triggers" for
// the conditions that should re-open path (a) and empty this allowlist.

interface DeferredAdminLowRiskEntry {
  /**
   * Repo-relative path of the admin route file. Mirrors the format used
   * by ALLOWED_MEDUSA_DIRECT.
   */
  readonly file: string
  /**
   * The bare service-call shape that bypasses *FromEnvelope. The pattern
   * is anchored with `\b...(` so a future call site that introduces a
   * similarly-named method (e.g., `tableSvc.upsert2(...)`) does NOT
   * accidentally pass the gate.
   */
  readonly pattern: RegExp
  /**
   * Short rationale (one line). The full rationale is in
   * W7-DECISIONS-admin.md — this is the at-a-glance reminder for the
   * test failure message.
   */
  readonly rationale: string
}

const DEFERRED_ADMIN_LOW_RISK: readonly DeferredAdminLowRiskEntry[] = [
  // ── apps/api/src/routes/admin/schedule.ts ──────────────────────────
  //
  // 1. PUT /api/admin/schedule/weekly — operator-driven weekly hours.
  //    Manager-role-only, low-frequency, no LLM caller, no PII.
  {
    file: "apps/api/src/routes/admin/schedule.ts",
    pattern: /\bsvc\.upsertDay\s*\(/,
    rationale:
      "schedule.upsertDay — operator-only weekly-hours upsert, manager-role gated, no LLM caller",
  },
  // 2. POST /api/admin/schedule/holidays — add holiday entry.
  //    Same risk profile as upsertDay (operator-only, low blast).
  {
    file: "apps/api/src/routes/admin/schedule.ts",
    pattern: /\bsvc\.addHoliday\s*\(/,
    rationale:
      "schedule.addHoliday — operator-only holiday create, manager-role gated, no LLM caller",
  },
  // 3. DELETE /api/admin/schedule/holidays/:id — remove holiday.
  {
    file: "apps/api/src/routes/admin/schedule.ts",
    pattern: /\bsvc\.removeHoliday\s*\(/,
    rationale:
      "schedule.removeHoliday — operator-only holiday delete, manager-role gated, no LLM caller",
  },
  // 4. PUT /api/admin/schedule/overrides/:date — per-date schedule override.
  {
    file: "apps/api/src/routes/admin/schedule.ts",
    pattern: /\bsvc\.upsertOverride\s*\(/,
    rationale:
      "schedule.upsertOverride — operator-only per-date override, manager-role gated, no LLM caller",
  },
  // 5. DELETE /api/admin/schedule/overrides/:date — remove override.
  {
    file: "apps/api/src/routes/admin/schedule.ts",
    pattern: /\bsvc\.removeOverride\s*\(/,
    rationale:
      "schedule.removeOverride — operator-only override delete, manager-role gated, no LLM caller",
  },
  // ── apps/api/src/routes/admin/tables.ts ────────────────────────────
  //
  // 6. POST /api/admin/tables — table create (OPS-018).
  //    Manager-role-only, low-frequency, no LLM caller, no PII. Route
  //    layer rejects a duplicate table number with a 409.
  {
    file: "apps/api/src/routes/admin/tables.ts",
    pattern: /\btableSvc\.create\s*\(/,
    rationale:
      "table.create — operator-only table CRUD, manager-role gated, no LLM caller",
  },
  // 6b. PATCH /api/admin/tables/:id (partial update) + DELETE
  //     /api/admin/tables/:id (soft-deactivate via active:false) both
  //     route through `tableSvc.update` (OPS-018). Same operator-only,
  //     low-blast risk profile as the create above.
  {
    file: "apps/api/src/routes/admin/tables.ts",
    pattern: /\btableSvc\.update\s*\(/,
    rationale:
      "table.update — operator-only partial-update + soft-deactivate, manager-role gated, no LLM caller",
  },
  // 7. POST /api/admin/timeslots — bulk-create reservation slots.
  //    Idempotent (skipDuplicates), manager-role-only.
  {
    file: "apps/api/src/routes/admin/tables.ts",
    pattern: /\btableSvc\.generateTimeSlots\s*\(/,
    rationale:
      "table.generateTimeSlots — idempotent bulk slot generation, manager-role gated, no LLM caller",
  },
  // ── apps/api/src/routes/admin/delivery-zones.ts ────────────────────
  //
  // 8. POST /api/admin/delivery-zones — create delivery zone.
  //    Route layer rejects duplicate CEPs; manager-role-only.
  {
    file: "apps/api/src/routes/admin/delivery-zones.ts",
    pattern: /\bdeliveryZoneSvc\.create\s*\(/,
    rationale:
      "deliveryZone.create — operator-only zone create with Redis dedup, manager-role gated, no LLM caller",
  },
  // 9. PUT /api/admin/delivery-zones/:id — update delivery zone.
  //    Route layer rejects CEP collisions with other zones; manager-role-only.
  {
    file: "apps/api/src/routes/admin/delivery-zones.ts",
    pattern: /\bdeliveryZoneSvc\.update\s*\(/,
    rationale:
      "deliveryZone.update — operator-only zone update with collision-check + Redis dedup, manager-role gated, no LLM caller",
  },
  // 10. DELETE /api/admin/delivery-zones/:id — remove delivery zone.
  //     Same risk profile as create/update; Redis dedup applied.
  {
    file: "apps/api/src/routes/admin/delivery-zones.ts",
    pattern: /\bdeliveryZoneSvc\.remove\s*\(/,
    rationale:
      "deliveryZone.remove — operator-only zone delete with Redis dedup, manager-role gated, no LLM caller",
  },
] as const

/**
 * Files scanned for bare service-call shapes (W7-P2). Each file in
 * this set MUST have at least one corresponding DEFERRED_ADMIN_LOW_RISK
 * entry — otherwise the file should not be in the scan surface (it
 * either uses *FromEnvelope properly, or it doesn't have admin
 * mutations at all).
 */
const ADMIN_LOW_RISK_SCAN_FILES = [
  "apps/api/src/routes/admin/schedule.ts",
  "apps/api/src/routes/admin/tables.ts",
  "apps/api/src/routes/admin/delivery-zones.ts",
] as const

/**
 * The set of bare-call regex shapes the W7-P2 gate looks for in the
 * admin route files. If any of these patterns appears in one of the
 * scanned files but does NOT have a matching `(file, pattern)` entry
 * in DEFERRED_ADMIN_LOW_RISK, the test fails. Future-proofs against
 * a developer adding a NEW bare service call (e.g.,
 * `tableSvc.deleteAll(...)`) without either routing through an
 * envelope OR adding a deferral entry.
 *
 * Regex shape: `\b<svc>\.<mutator>\s*\(` — anchored to the service
 * variable names used in the 3 admin routes today
 * (`svc`, `tableSvc`, `deliveryZoneSvc`) AND any method name that
 * looks like a mutator (`create`, `update`, `upsert`, `delete`,
 * `remove`, `add`, `generate`, `seed`). Read-only methods (`listAll`,
 * `findActiveByPrefix`, `getFullSchedule`, etc.) are NOT matched.
 */
const BARE_ADMIN_SERVICE_CALL_PATTERNS: readonly RegExp[] = [
  /\bsvc\.(?:create|update|upsert|delete|remove|add|generate|seed)[A-Z]\w*\s*\(/,
  /\btableSvc\.(?:create|update|upsert|delete|remove|add|generate|seed)\w*\s*\(/,
  /\bdeliveryZoneSvc\.(?:create|update|upsert|delete|remove|add|generate|seed)\w*\s*\(/,
] as const

describe("Bypass detection — W7-P2: admin scheduler/tables/zones DEFERRED_ADMIN_LOW_RISK", () => {
  // Helper: collect all bare-call hits across the 3 admin route files.
  function collectAdminBareCalls(): Array<{
    file: string
    line: number
    text: string
  }> {
    const hits: Array<{ file: string; line: number; text: string }> = []
    for (const rel of ADMIN_LOW_RISK_SCAN_FILES) {
      const abs = join(REPO_ROOT, rel)
      let content: string
      try {
        content = readFileSync(abs, "utf8")
      } catch {
        // Missing file is itself a regression — flagged by a separate
        // test below.
        continue
      }
      const lines = content.split("\n")
      lines.forEach((text, i) => {
        if (isCommentLine(text)) return
        for (const pattern of BARE_ADMIN_SERVICE_CALL_PATTERNS) {
          if (pattern.test(text)) {
            hits.push({ file: rel, line: i + 1, text: text.trim() })
            // One pattern match per line is enough; avoid double-reporting.
            return
          }
        }
      })
    }
    return hits
  }

  it("every bare admin service call in the scan files matches a DEFERRED_ADMIN_LOW_RISK entry", () => {
    const hits = collectAdminBareCalls()
    // For each hit, find a matching allowlist entry by (file, pattern).
    const orphans: Array<{ file: string; line: number; text: string }> = []
    for (const hit of hits) {
      const matched = DEFERRED_ADMIN_LOW_RISK.some(
        (entry) => entry.file === hit.file && entry.pattern.test(hit.text),
      )
      if (!matched) {
        orphans.push(hit)
      }
    }
    if (orphans.length > 0) {
      const lines = orphans
        .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
        .join("\n")
      throw new Error(
        `Bare admin service-call detected outside DEFERRED_ADMIN_LOW_RISK — either route the call through a new *FromEnvelope on the underlying service, OR add an entry to DEFERRED_ADMIN_LOW_RISK with a rationale (see W7-DECISIONS-admin.md §"Follow-up triggers").\n\nNew bare-call sites (${orphans.length}):\n${lines}`,
      )
    }
    expect(orphans).toEqual([])
  })

  it("every DEFERRED_ADMIN_LOW_RISK entry actually appears in its referenced file (sentinel)", () => {
    // Sentinel: if a route is migrated to *FromEnvelope but the
    // allowlist entry is left behind, the entry rots and a future
    // developer can't tell whether the deferral is still live. Force
    // every allowlist entry to map to a real call site OR be removed
    // from the allowlist.
    const stale: Array<{ file: string; pattern: string; rationale: string }> =
      []
    for (const entry of DEFERRED_ADMIN_LOW_RISK) {
      const abs = join(REPO_ROOT, entry.file)
      let content: string
      try {
        content = readFileSync(abs, "utf8")
      } catch {
        stale.push({
          file: entry.file,
          pattern: entry.pattern.source,
          rationale: `file missing: ${entry.rationale}`,
        })
        continue
      }
      if (!entry.pattern.test(content)) {
        stale.push({
          file: entry.file,
          pattern: entry.pattern.source,
          rationale: entry.rationale,
        })
      }
    }
    if (stale.length > 0) {
      const lines = stale
        .map(
          (s) =>
            `  • ${s.file}  →  pattern /${s.pattern}/  (rationale: ${s.rationale})`,
        )
        .join("\n")
      throw new Error(
        `DEFERRED_ADMIN_LOW_RISK contains stale entries — the bare-call pattern no longer appears in the referenced file. Either remove the entry (because the route was migrated to *FromEnvelope), or fix the test if the pattern needs adjustment.\n\nStale entries (${stale.length}):\n${lines}`,
      )
    }
    expect(stale).toEqual([])
  })

  it("DEFERRED_ADMIN_LOW_RISK size matches the W7-P2 baseline (11 entries — promotion sentinel)", () => {
    // W7-P2 baseline: 10 bare-call sites — the 6 P0/P1 sites enumerated
    // in `wave6-governance-coverage.md` §"10 — New bypasses discovered"
    // rows 6–11, PLUS 4 additional delete/holiday-add/holiday-remove
    // sites the W6 inventory under-counted (they share the same
    // operator-only, low-blast risk profile as the 6 P0/P1 sites — see
    // W7-DECISIONS-admin.md §"What this commit changes" for the full
    // 10-site enumeration with rationale per site).
    //
    // If this number changes WITHOUT a corresponding update to
    // W7-DECISIONS-admin.md, the change is suspect. Two failure modes:
    //
    //   - Size grows: a new admin mutation was added with a deferral
    //     entry but the trade-off was not re-evaluated. The W7-DECISIONS
    //     doc captured the rationale for THIS specific 10-site surface;
    //     an 11th site should be evaluated against the same criteria,
    //     and ideally either routed through an envelope OR documented
    //     in a follow-up W8-DECISIONS-admin.md.
    //   - Size shrinks: a site was migrated to *FromEnvelope (good!)
    //     but the test acceptance criteria need to be updated to lock
    //     in the new baseline. Drop the size to the new count and
    //     update W7-DECISIONS-admin.md with a "migration progress" note.
    //
    // The sentinel is intentionally strict (equality, not "≤ 11") to
    // catch silent additions.
    //
    // OPS-018 (2026-07): the single POST /api/admin/tables `tableSvc.upsert`
    // site was split into `tableSvc.create` (POST) + `tableSvc.update`
    // (PATCH partial-update AND DELETE soft-deactivate), taking the baseline
    // 10 → 11. Same operator-only, manager-gated, no-LLM-caller risk profile
    // as the site it replaced — no new risk class introduced.
    expect(DEFERRED_ADMIN_LOW_RISK).toHaveLength(11)
  })
})

// NOTE (claustrum-on-dev WS8): the former "runtime smoke: dispatcher
// refuses unknown tool" describe block was deleted with the legacy
// `@ibatexas/llm-provider` package. Its subject — `createIntentDispatcher`
// / `createDefaultDispatchHandlers` (the post-adjudication EXECUTE
// dispatcher) — was BRAIN code removed when routes moved to the claustrum
// Conductor (WS7). No replacement exists, so the block has no subject.
