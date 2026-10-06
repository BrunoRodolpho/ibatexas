// F-22 — structural gate: no runtime branching on optional Redis features.
//
// # The policy this pins
//
// > Capabilities are validated at composition root. Runtime should never
// > branch based on optional Redis features.
//
// The measured class had two members, with different failure modes:
//
//   1. `adapters/park-nx.ts` `releaseNxPlaceholder` — `typeof r.eval ===
//      "function"`, then `catch { /* fall through */ }` → an unconditional
//      `del`. A detect-miss AND an eval throw both degraded the compare-and-
//      delete to a blind DEL, in exactly the failure mode (a Redis blip) the
//      CAD was written for.
//   2. `@adjudicate/runtime`'s `parkDeferredIntent` — `typeof
//      args.redis.evalIncrCheck === "function"` with a NON-ATOMIC fallback.
//      That package is EXTERNAL (pinned npm dep; source of truth is the
//      platform repo) and is not editable here; the in-repo answer is the
//      composition guarantee, which makes the probe deterministically TRUE
//      and the fallback dead code. See the F-22 section of
//      `apps/api/src/__tests__/helpers/redis-double-census.md`.
//
// # What the gate does
//
// Walks the PRODUCTION sources of `apps/api/src` and `packages/tools/src` and
// fails on any `typeof <expr>.<redisCommand> [!=]== "function"` probe, or any
// `"<redisCommand>" in <expr>` probe, outside a hand-written allowlist.
//
// `__tests__` is excluded (mirroring `nx-park-conformance.test.ts`): a test
// legitimately probes shapes, and a test cannot ship a degraded runtime path.
//
// # Why the allowlist is hand-written, and how we know it is load-bearing
//
// The allowlist is a literal set of paths, NOT anything derived from the scan
// it governs — a derived control cannot fail (F-14). And an allowlist entry
// that would never have been flagged anyway is decoration, so the control case
// below re-runs the SAME scan with the allowlist EMPTIED and requires the
// entry's file to be reported. If someone rewrites the validator into a form
// the regex misses, that control reds and the entry stops being a claim.
//
// Modeled on `bypass-detection.test.ts` / `nx-park-conformance.test.ts`:
// multi-line-safe scan with length-preserving comment stripping, allowlist with
// documented carve-outs, fail-loud message pointing at file:line.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, it, expect } from "vitest"

// __dirname → apps/api/src/__tests__/bypass-detection ; repo root → ../../../../..
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

// ── Scan surfaces ─────────────────────────────────────────────────────────────

/**
 * Production sources scanned. `apps/api/src` is where the class was measured;
 * `packages/tools/src` owns `getRedisClient` and every shared Redis helper, so
 * a fallback introduced there would reach every app.
 */
const SCAN_DIRS = ["apps/api/src", "packages/tools/src"] as const

// ── The Redis command vocabulary (hand-written) ───────────────────────────────

/**
 * Command names that anchor the probe patterns. HAND-WRITTEN: the anchor is
 * what keeps the gate off unrelated shape checks — `typeof timer.unref ===
 * "function"` (a Node timer handle, `kernel-bootstrap.ts` /
 * `agent-trigger-bridge.ts`) is not a Redis capability and must not be flagged.
 *
 * Atomicity-bearing commands lead the list because they are the ones whose
 * absence tempts a degraded fallback; the ordinary commands follow because a
 * `typeof r.del === "function"` fallback would be the same defect class.
 */
const REDIS_COMMANDS = [
  // atomicity-bearing
  "eval",
  "evalSha",
  "evalIncrCheck",
  "sendCommand",
  "multi",
  "watch",
  "unwatch",
  // ordinary key/value + counter surface
  "set",
  "setNX",
  "get",
  "getDel",
  "del",
  "unlink",
  "incr",
  "incrBy",
  "decr",
  "decrBy",
  "expire",
  "pExpire",
  "ttl",
  "pTtl",
  "exists",
  "scan",
  "scanIterator",
  "flushAll",
] as const

const COMMAND_ALTERNATION = REDIS_COMMANDS.join("|")

/**
 * `typeof <anything>.<redisCommand> === "function"` — and the `!==` spelling,
 * and optional-chained access (`c?.eval`). This is the exact shape of both
 * measured defects.
 */
const FORBIDDEN_TYPEOF_PROBE = new RegExp(
  String.raw`typeof\s+[^\n;]{0,160}\??\.\s*(?:${COMMAND_ALTERNATION})\b[^\n;]{0,80}[!=]==\s*["']function["']`,
  "g",
)

/** The sibling spelling: `"eval" in client`. */
const FORBIDDEN_IN_PROBE = new RegExp(
  String.raw`["'](?:${COMMAND_ALTERNATION})["']\s+in\s+[A-Za-z_$(]`,
  "g",
)

// ── Allowlist ─────────────────────────────────────────────────────────────────

/**
 * The ONLY files permitted to probe a Redis capability. New entries REQUIRE a
 * rationale that explains why the probe's outcome is not a behavioural branch.
 */
const ALLOWED_CAPABILITY_PROBE: ReadonlySet<string> = new Set<string>([
  // THE composition root. Its per-command roll call is the F-22 policy itself:
  // the probe's only outcome is a THROW (`RedisCapabilityUnavailableError`) —
  // it never selects between a fast path and a degraded one. Everything
  // downstream then consumes a surface whose atomic members are REQUIRED, so
  // no other file has anything left to ask.
  "apps/api/src/adapters/park-redis-capabilities.ts",
])

// ── Walker (mirror of nx-park-conformance.test.ts) ────────────────────────────

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
    } else if (
      stat.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".d.ts") &&
      !full.endsWith(".test.ts")
    ) {
      out.push(full)
    }
  }
  return out
}

/** Strip comments, preserving length so line numbers stay aligned. */
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

/**
 * @param allowlist injected so the control case can re-run the SAME scan with
 *   it emptied. Never defaulted to a value derived from the scan.
 */
function scanForCapabilityProbes(
  allowlist: ReadonlySet<string> = ALLOWED_CAPABILITY_PROBE,
): Offender[] {
  const offenders: Offender[] = []
  for (const scanDir of SCAN_DIRS) {
    const files = walkTs(join(REPO_ROOT, scanDir))
    for (const file of files) {
      const rel = relative(REPO_ROOT, file)
      if (allowlist.has(rel)) continue
      const stripped = stripComments(readFileSync(file, "utf8"))
      for (const pattern of [FORBIDDEN_TYPEOF_PROBE, FORBIDDEN_IN_PROBE]) {
        pattern.lastIndex = 0
        for (const m of stripped.matchAll(pattern)) {
          if (m.index === undefined) continue
          offenders.push({
            file: rel,
            line: stripped.slice(0, m.index).split("\n").length,
            text: m[0].replace(/\s+/g, " ").trim().slice(0, 120),
          })
        }
      }
    }
  }
  return offenders
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("F-22 — Redis capability-detection conformance", () => {
  it("no production file branches on an optional Redis capability", () => {
    const offenders = scanForCapabilityProbes()
    if (offenders.length > 0) {
      throw new Error(
        `Redis capability feature-detection found in production code (F-22).\n\n` +
          `Policy: capabilities are validated at the COMPOSITION ROOT; the runtime ` +
          `never branches on whether a Redis command exists. A \`typeof ` +
          `client.<cmd> === "function"\` guard always has a fallback behind it, and ` +
          `that fallback is the defect — F-22's original site degraded a Lua ` +
          `compare-and-delete to a blind DEL exactly when a Redis blip made the ` +
          `CAD matter most.\n\n` +
          `Offending sites (${offenders.length}):\n` +
          offenders.map((o) => `  • ${o.file}:${o.line}  →  ${o.text}`).join("\n") +
          `\n\nFix: take the capability from ` +
          `\`createParkRedisCapabilities()\` (or an equivalent composition-root ` +
          `factory) so the member is REQUIRED and the branch disappears. If a probe ` +
          `is genuinely legitimate — i.e. its ONLY outcome is a throw, never a ` +
          `degraded path — add the file to \`ALLOWED_CAPABILITY_PROBE\` in this ` +
          `test with a rationale.`,
      )
    }
    expect(offenders).toEqual([])
  })

  // ── The allowlist is a claim, not decoration ─────────────────────────────

  it("control — with the allowlist EMPTIED, the composition root IS reported", () => {
    // Proves two things at once: the scan reaches that file, and the regex
    // actually matches the form the validator is written in. Without this, the
    // allowlist entry could be guarding nothing and the case above would be
    // green for the wrong reason.
    const offenders = scanForCapabilityProbes(new Set<string>())
    const inValidator = offenders.filter(
      (o) => o.file === "apps/api/src/adapters/park-redis-capabilities.ts",
    )
    // One per required command in the roll call.
    expect(inValidator.length).toBeGreaterThanOrEqual(5)
    expect(inValidator.some((o) => /\beval\b/.test(o.text))).toBe(true)
  })

  it("control — with the allowlist EMPTIED, the composition root is the ONLY offender", () => {
    // The complement of the case above: if some other production file were
    // relying on the allowlist mechanism, it would show up here.
    const offenders = scanForCapabilityProbes(new Set<string>())
    const others = offenders.filter(
      (o) => o.file !== "apps/api/src/adapters/park-redis-capabilities.ts",
    )
    expect(others).toEqual([])
  })

  it("ALLOWED_CAPABILITY_PROBE holds exactly one entry (sentinel against silent growth)", () => {
    expect([...ALLOWED_CAPABILITY_PROBE]).toEqual([
      "apps/api/src/adapters/park-redis-capabilities.ts",
    ])
  })

  it("every allowlist entry names a file that exists", () => {
    const stale: string[] = []
    for (const rel of ALLOWED_CAPABILITY_PROBE) {
      try {
        if (!statSync(join(REPO_ROOT, rel)).isFile()) stale.push(rel)
      } catch {
        stale.push(rel)
      }
    }
    expect(stale).toEqual([])
  })

  // ── Positive regex controls: the pattern catches the real shapes ─────────

  it("catches the pre-F-22 park-nx probe VERBATIM", () => {
    const verbatim = `  if (typeof r.eval === "function") {`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(Array.from(verbatim.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(1)
  })

  it("catches the @adjudicate/runtime probe shape (nested property access)", () => {
    const shape = `if (typeof args.redis.evalIncrCheck === "function") {`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(Array.from(shape.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(1)
  })

  it("catches the cast-then-probe evasion", () => {
    const shape = `if (typeof (redis as { del?: () => void }).del === "function") {`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(
      Array.from(shape.matchAll(FORBIDDEN_TYPEOF_PROBE)).length,
    ).toBeGreaterThanOrEqual(1)
  })

  it("catches the optional-chained and negated spellings", () => {
    const optional = `if (typeof c?.eval !== "function") missing.push("eval")`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(Array.from(optional.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(1)
  })

  it("catches the single-quoted spelling", () => {
    const single = `if (typeof r.evalSha === 'function') {`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(Array.from(single.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(1)
  })

  it("catches the `in` spelling", () => {
    const inForm = `if ("evalIncrCheck" in redisClient) {`
    FORBIDDEN_IN_PROBE.lastIndex = 0
    expect(Array.from(inForm.matchAll(FORBIDDEN_IN_PROBE))).toHaveLength(1)
  })

  // ── Negative regex controls: the anchor keeps the gate quiet ─────────────

  it("does NOT catch a Node timer-handle shape check", () => {
    // kernel-bootstrap.ts:758 and agent-trigger-bridge.ts:273. `unref` is not a
    // Redis command; the command vocabulary is what keeps these out.
    const timer = `if (typeof _deferPendingPoll.unref === "function") _deferPendingPoll.unref()`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(Array.from(timer.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(0)
  })

  it("does NOT catch a logger shape check", () => {
    const logger = `typeof provided.warn === "function" && typeof provided.error === "function"`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    expect(Array.from(logger.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(0)
  })

  it("does NOT catch an ordinary Redis CALL (only a probe about one)", () => {
    const call = `await redis.eval(RELEASE_SCRIPT, { keys: [k], arguments: [v] })`
    FORBIDDEN_TYPEOF_PROBE.lastIndex = 0
    FORBIDDEN_IN_PROBE.lastIndex = 0
    expect(Array.from(call.matchAll(FORBIDDEN_TYPEOF_PROBE))).toHaveLength(0)
    expect(Array.from(call.matchAll(FORBIDDEN_IN_PROBE))).toHaveLength(0)
  })

  // ── The vocabulary is a hand-written wire list ───────────────────────────

  it("the command vocabulary covers the atomicity-bearing commands by NAME", () => {
    // Name pin, not a count: a rename or a drop is what would silently open a
    // hole, and `eval` / `evalIncrCheck` are the two the measured class used.
    for (const cmd of [
      "eval",
      "evalSha",
      "evalIncrCheck",
      "sendCommand",
      "multi",
      "watch",
      "del",
      "unlink",
      "incr",
      "decr",
      "expire",
    ]) {
      expect(REDIS_COMMANDS as readonly string[]).toContain(cmd)
    }
  })
})
