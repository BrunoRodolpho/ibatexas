// audit-2026-05-24 — Hardening test T1: NX-park conformance.
//
// # Why this test exists
//
// SYNTHESIS.md §P0-1: four production callers (kernel-executor.ts,
// llm-responder.ts, me.ts ×2) imported the raw `parkDeferredIntent` from
// `@adjudicate/runtime` instead of `parkDeferredIntentWithNxGuard`. The
// framework's raw primitive does a plain `redis.set(EX)` without NX, so
// two back-to-back DEFERs for the same sessionId silently overwrite each
// other and the first parked envelope's payload is lost.
//
// The bug had escaped multiple verification passes because no CI gate
// detected the *class* of foot-gun. This test closes the class by failing
// the build the moment any production file imports `parkDeferredIntent`
// as a named symbol from `@adjudicate/runtime` outside two legitimate sites:
//
//   1. `packages/llm-provider/src/park-nx.ts` — the wrapper that itself
//      wraps the framework primitive.
//   2. `apps/api/src/adapters/park-deferred-intent-nx.ts` — apps/api shim.
//
// Modeled after `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`:
// multi-line grep with same-length comment stripping, allowlist with
// documented carve-outs, fail-loud error message pointing at file:line.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, it, expect } from "vitest"

// ── Repo root ─────────────────────────────────────────────────────────────

// __dirname → apps/api/src/__tests__/bypass-detection
// repo root  → ../../../../../
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

// ── Scan surfaces ─────────────────────────────────────────────────────────

/**
 * Directories scanned for direct `parkDeferredIntent` imports. The wrapper
 * is in `packages/llm-provider/src/` and the cart/medusa/twilio/stripe
 * wrappers in `packages/tools/src/`; both are INCLUDED so a new wrapper
 * gaining DEFER-park capability via the framework primitive is caught.
 * The wrapper's own legitimate import is allowlisted below.
 */
const PARK_SCAN_DIRS = [
  "apps/api/src",
  "packages/llm-provider/src",
  "packages/tools/src",
] as const

/**
 * Production files permitted to import `parkDeferredIntent` as a named
 * symbol from `@adjudicate/runtime`. New entries REQUIRE a rationale.
 */
const ALLOWED_DIRECT_PARK_IMPORT: ReadonlySet<string> = new Set<string>([
  // The wrapper itself — `parkDeferredIntent` is the framework primitive
  // that `parkDeferredIntentWithNxGuard` delegates to AFTER claiming the
  // NX slot. This is the one and only canonical caller.
  "packages/llm-provider/src/park-nx.ts",
  // The apps/api re-export shim. Doesn't import the primitive today but
  // included defensively for future refactors that re-introduce a bridge
  // import the wrapper still owns.
  "apps/api/src/adapters/park-deferred-intent-nx.ts",
])

// ── Forbidden pattern ─────────────────────────────────────────────────────

/**
 * Multi-line import pattern matching:
 *
 *   import { ..., parkDeferredIntent[, ...] } from "@adjudicate/runtime"
 *   import { parkDeferredIntent } from "@adjudicate/runtime"
 *   import { parkDeferredIntent,\n  ...\n} from "@adjudicate/runtime"
 *   import type { parkDeferredIntent } from "@adjudicate/runtime"
 *
 * The `\b` after `parkDeferredIntent` is load-bearing — it prevents
 * `parkDeferredIntentWithNxGuard` (which has extra word chars after) from
 * triggering. Multi-line via `s` (dotall) flag — TS named-import lists
 * commonly span lines.
 */
const FORBIDDEN_PARK_IMPORT =
  /import\s+(?:type\s+)?\{[^}]*?\bparkDeferredIntent\b[^}]*?\}\s*from\s*["']@adjudicate\/runtime["']/gs

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
 * Strip line + block comments, preserving newlines so line numbers stay
 * aligned. Mirrors `stripComments` from `bypass-detection.test.ts`.
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

interface Offender {
  readonly file: string
  readonly line: number
  readonly text: string
}

function scanForDirectParkImports(): Offender[] {
  const offenders: Offender[] = []
  for (const scanDir of PARK_SCAN_DIRS) {
    const absDir = join(REPO_ROOT, scanDir)
    const files = walkTs(absDir)
    for (const file of files) {
      const rel = relative(REPO_ROOT, file)
      if (ALLOWED_DIRECT_PARK_IMPORT.has(rel)) continue
      const raw = readFileSync(file, "utf8")
      const stripped = stripComments(raw)
      // Reset regex state defensively — RegExp with `g` flag is stateful.
      FORBIDDEN_PARK_IMPORT.lastIndex = 0
      for (const m of stripped.matchAll(FORBIDDEN_PARK_IMPORT)) {
        if (m.index === undefined) continue
        const line = stripped.slice(0, m.index).split("\n").length
        const snippet = raw
          .slice(m.index, m.index + 160)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120)
        offenders.push({ file: rel, line, text: snippet })
      }
    }
  }
  return offenders
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("audit-2026-05-24 T1 — NX-park conformance", () => {
  it("no production file imports `parkDeferredIntent` directly from @adjudicate/runtime (outside the wrapper)", () => {
    const offenders = scanForDirectParkImports()
    if (offenders.length > 0) {
      const lines = offenders
        .map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`)
        .join("\n")
      throw new Error(
        `Direct import of \`parkDeferredIntent\` from \`@adjudicate/runtime\` detected — ` +
          `route through \`parkDeferredIntentWithNxGuard\` (the NX-guarded wrapper in ` +
          `\`@ibatexas/llm-provider\`) instead.\n\n` +
          `The framework primitive uses a plain \`redis.set(EX)\` without NX, so two ` +
          `back-to-back DEFERs for the same sessionId silently overwrite each other. ` +
          `The NX wrapper claims the park slot via SETNX and refuses the second caller ` +
          `with \`PARK_COLLISION_REFUSAL_PT_BR\`.\n\n` +
          `Offending sites (${offenders.length}):\n${lines}\n\n` +
          `If this import is legitimate (e.g., a new wrapper-of-the-wrapper), add the ` +
          `file path to \`ALLOWED_DIRECT_PARK_IMPORT\` in this test with a comment ` +
          `explaining the carve-out.\n\n` +
          `Background: audit-2026-05-24 SYNTHESIS.md §P0-1.`,
      )
    }
    expect(offenders).toEqual([])
  })

  it("ALLOWED_DIRECT_PARK_IMPORT has exactly 2 entries (sentinel against silent allowlist growth)", () => {
    // Two entries: wrapper itself + apps/api re-export shim. Any change
    // to this count means a new carve-out was added; reviewer must
    // scrutinise the rationale comment. The shim is defensive (currently
    // doesn't import the primitive; keeps the test stable against
    // refactors that may re-introduce a runtime import there).
    expect(ALLOWED_DIRECT_PARK_IMPORT.size).toBe(2)
  })

  it("ALLOWED_DIRECT_PARK_IMPORT entries reference files that actually exist", () => {
    // Sentinel against allowlist rotting after a file move.
    const stale: string[] = []
    for (const rel of ALLOWED_DIRECT_PARK_IMPORT) {
      const abs = join(REPO_ROOT, rel)
      try {
        const stat = statSync(abs)
        if (!stat.isFile()) stale.push(rel)
      } catch {
        stale.push(rel)
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `ALLOWED_DIRECT_PARK_IMPORT contains stale entries — file does not exist:\n` +
          stale.map((s) => `  • ${s}`).join("\n") +
          `\n\nEither restore the file OR drop the entry from the allowlist.`,
      )
    }
    expect(stale).toEqual([])
  })

  it("the wrapper itself (`packages/llm-provider/src/park-nx.ts`) is in the allowlist (sentinel)", () => {
    // If this assertion ever fails, the canonical wrapper's carve-out
    // was dropped — the test would then flag the wrapper as offender.
    expect(
      ALLOWED_DIRECT_PARK_IMPORT.has("packages/llm-provider/src/park-nx.ts"),
    ).toBe(true)
  })

  it("`parkDeferredIntentWithNxGuard` (the wrapper) IS NOT itself caught by the regex (negative test)", () => {
    // The `\b` word boundary after `parkDeferredIntent` is load-bearing.
    // Without it, the regex catches the wrapper too. Pin the contract.
    const synthetic =
      `import { parkDeferredIntentWithNxGuard } from "@adjudicate/runtime"`
    expect(synthetic.match(FORBIDDEN_PARK_IMPORT)).toBeNull()
  })

  it("`parkDeferredIntent` (raw) IS caught by the regex (positive test)", () => {
    const synthetic =
      `import { parkDeferredIntent } from "@adjudicate/runtime"`
    const matches = Array.from(synthetic.matchAll(FORBIDDEN_PARK_IMPORT))
    expect(matches.length).toBe(1)
  })

  it("multi-line `parkDeferredIntent` import IS caught by the regex (positive test)", () => {
    // Multi-line named-import lists must be caught — the pre-fix regex
    // without `s` (dotall) flag would have missed this shape.
    const synthetic = [
      `import {`,
      `  buildEnvelope,`,
      `  parkDeferredIntent,`,
      `  type IntentEnvelope,`,
      `} from "@adjudicate/runtime"`,
    ].join("\n")
    const matches = Array.from(synthetic.matchAll(FORBIDDEN_PARK_IMPORT))
    expect(matches.length).toBe(1)
  })

  it("`type parkDeferredIntent` (type-only) IS caught (positive test)", () => {
    // A type-only import of the primitive is almost certainly a typo /
    // refactor leftover; flagging surfaces it before it becomes a value
    // import.
    const synthetic =
      `import type { parkDeferredIntent } from "@adjudicate/runtime"`
    const matches = Array.from(synthetic.matchAll(FORBIDDEN_PARK_IMPORT))
    expect(matches.length).toBe(1)
  })
})
