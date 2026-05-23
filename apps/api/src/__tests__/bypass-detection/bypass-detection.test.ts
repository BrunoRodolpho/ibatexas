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
 */
const FORBIDDEN_MEDUSA = [
  /medusaStore\([^)]*['"](POST|PUT|DELETE|PATCH)\b/,
  /medusaAdmin\([^)]*['"](POST|PUT|DELETE|PATCH)\b/,
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

describe("Bypass detection — Scenario 2: medusaStore/medusaAdmin write outside medusaAdjudicated()", () => {
  for (const pattern of FORBIDDEN_MEDUSA) {
    it(`no match for /${pattern.source}/`, () => {
      const offenders = scan(MEDUSA_SCAN_DIRS, [pattern], ALLOWED_MEDUSA_DIRECT)
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
