// audit-2026-05-24 — Hardening test T7: idempotency-key conformance.
//
// # Why this test exists
//
// SYNTHESIS.md §P0-7: 4 wrappers (medusa{Admin,Store}Adjudicated,
// stripeAdjudicated, twilioAdjudicated) fall back to `randomUUID()` for
// the envelope nonce when no `idempotencyKey` is supplied. That makes
// `intentHash` non-deterministic across retries (HTTP retries, WhatsApp
// resends, sweeper re-emits) — the kernel's Execution Ledger sees each
// retry as a NEW intent and the dedup guarantee silently fails.
//
// R1-5 (commit f793cbd) closed the 5 highest-priority sites. The remaining
// LLM cart tools + WhatsApp sends are allowlisted below with rationale.
//
// Every wrapper-call in production MUST either:
//   (a) supply `meta.idempotencyKey` (or `idempotencyKey` as a sibling
//       arg for the `medusaAdjudicated` single-arg shape), OR
//   (b) appear in `BEST_EFFORT_DEDUP_ALLOWLIST` with a rationale comment.
//
// Static grep, no runtime — completes well under 1s. Modeled on
// `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, it, expect } from "vitest"

// ── Repo root ─────────────────────────────────────────────────────────────

// __dirname → apps/api/src/__tests__/audit-2026-05-24
// repo root  → ../../../../../
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

// ── Scan surfaces ─────────────────────────────────────────────────────────

/** Directories scanned for wrapper-call sites. */
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

/** Wrapper source files — they DEFINE the wrappers, don't CALL them. */
const WRAPPER_DEFINITION_FILES: ReadonlySet<string> = new Set<string>([
  "packages/tools/src/medusa/adjudicated.ts",
  "packages/tools/src/medusa/store-adjudicated.ts",
  "packages/tools/src/stripe/adjudicated.ts",
  "packages/tools/src/twilio/adjudicated.ts",
])

/**
 * BEST_EFFORT_DEDUP_ALLOWLIST — call sites that legitimately operate in
 * "best-effort dedup only" mode (no `idempotencyKey` supplied).
 *
 * Format: `<file>:<callExpression>`. New entries REQUIRE rationale.
 *
 * Acceptable rationales:
 *   - "self-deduping upstream" (downstream API enforces uniqueness)
 *   - "low-frequency operator-driven"
 *   - "fire-and-forget" (user-triggered, small blast)
 *
 * Unacceptable: "I forgot", "tests would break".
 *
 * Baseline (2026-05-24): SYNTHESIS.md §P0-7 catalogued ~25 LLM cart-tool
 * + 2 WhatsApp send sites with random nonces. R1-5 (commit f793cbd)
 * closed the 5 highest-priority routes; the rest are allowlisted below
 * with rationale and tracked for a future wave.
 */
const BEST_EFFORT_DEDUP_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // ── LLM cart-tool call sites (SYNTHESIS.md §P0-7) ─────────────────
  //
  // LLM hot-path tools — the LLM has no concept of an idempotency key
  // and derives nothing stable across retries. The proper fix threads
  // the responder's WhatsApp messageSid through ctx into meta; deferred
  // to a future wave. Best-effort dedup is acceptable because: (a) the
  // LLM proposes ONE mutation per turn; (b) HTTP retry of the SAME
  // LLM-proposed mutation is rare (the LLM rephrases on retry).
  "packages/tools/src/cart/add-to-cart.ts:medusaStoreAdjudicated.carts.lineItems.add",
  "packages/tools/src/cart/apply-coupon.ts:medusaStoreAdjudicated.carts.promotions.add",
  "packages/tools/src/cart/get-or-create-cart.ts:medusaStoreAdjudicated.carts.create",
  "packages/tools/src/cart/remove-from-cart.ts:medusaStoreAdjudicated.carts.lineItems.remove",
  "packages/tools/src/cart/update-cart.ts:medusaStoreAdjudicated.carts.lineItems.update",
  "packages/tools/src/cart/reorder.ts:medusaAdjudicated",

  // ── Checkout bookkeeping (SYNTHESIS.md §P0-7) ──────────────────────
  //
  // create-checkout.ts's 5 medusa-store sites are bookkeeping on a cart
  // that has already passed the ledger gate at the orchestrating call.
  // Duplicates are caught by Medusa's own cart-state guards (cart can't
  // be completed twice; payment-collection can't be re-attached).
  "packages/tools/src/cart/create-checkout.ts:medusaStoreAdjudicated.carts.promotions.add",
  "packages/tools/src/cart/create-checkout.ts:medusaStoreAdjudicated.carts.update",
  "packages/tools/src/cart/create-checkout.ts:medusaStoreAdjudicated.paymentCollections.create",
  "packages/tools/src/cart/create-checkout.ts:medusaStoreAdjudicated.paymentCollections.paymentSessions.create",
  "packages/tools/src/cart/create-checkout.ts:medusaStoreAdjudicated.carts.complete",

  // ── Outbound WhatsApp sends (SYNTHESIS.md §P0-7) ───────────────────
  //
  // Twilio's messages.create does NOT expose an SDK-level idempotency
  // header — passing idempotencyKey would help ledger-side dedup but
  // not prevent duplicate sends. Twilio itself enforces a 24h dedup on
  // (from, to, body); practical impact of a duplicate ledger entry is
  // observability noise, not a duplicate WhatsApp send. Proper fix:
  // thread messageSid through the retry loop. Tracked for follow-up.
  "apps/api/src/whatsapp/client.ts:twilioAdjudicated.messages.create",

  // ── amend-order Medusa order-edit lifecycle (SYNTHESIS.md §P0-7) ───
  //
  // 6 medusaAdjudicated bookkeeping calls in the order-edit lifecycle
  // (create-edit → add-item → confirm × two action paths). Each step
  // is gated by the previous step's editId; Medusa's order-edit state
  // machine rejects double-confirm and double-add on a resolved edit.
  // No HTTP-retry loop wraps these calls. Proper fix: derive key from
  // `${orderId}:${action}:${variantId|itemId}`. Tracked for follow-up.
  "packages/tools/src/cart/amend-order.ts:medusaAdjudicated",

  // ── _stripe-helpers stale-PI cancel (SYNTHESIS.md §P0-7) ───────────
  //
  // cancelStalePaymentIntent at _stripe-helpers.ts:32 is fire-and-forget:
  // the next step is gated by NEW PI creation (which has its own explicit
  // amend:pix:${orderId}:${newTotal} key). Cancel itself is idempotent at
  // the Stripe API — cancelling an already-canceled PI is a 4xx the caller
  // catches and treats as success.
  "packages/tools/src/cart/_stripe-helpers.ts:stripeAdjudicated.paymentIntents.cancel",
])

// ── Forbidden patterns ────────────────────────────────────────────────────

/**
 * Match the function reference + opening `(` of a wrapper call. The four
 * governed wrappers (SYNTHESIS.md §P0-7):
 *
 *   - `medusaAdjudicated` (ADMIN-scope; single args object)
 *   - `medusaStoreAdjudicated.*` (STORE-scope; (payload, meta) shape)
 *   - `stripeAdjudicated.*` (per-resource; (id, params?, meta) shape)
 *   - `twilioAdjudicated.messages.create` ((payload, meta) shape)
 *
 * The arg-block extraction step (below) pulls the full balanced span and
 * checks for the literal `idempotencyKey:` (or shorthand `,idempotencyKey,`).
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
 * from `bypass-detection.test.ts`.
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
 * literals). Needed because TS args commonly span nested object literals
 * which a flat regex can't handle.
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
  // Unbalanced — defensive fallback. Conformance check will then see the
  // full tail as the args block and likely fail "no idempotencyKey" loudly.
  return len - 1
}

// ── Scanning ─────────────────────────────────────────────────────────────

interface CallSite {
  readonly file: string
  readonly line: number
  readonly callExpression: string
  readonly hasIdempotencyKey: boolean
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
        // Skip import/export/type lines defensively (the `\b` mostly
        // handles this but a destructured re-export `{ wrapper } = ...`
        // followed by an IIFE invocation could slip through).
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
        // Accept `idempotencyKey: ...` OR `idempotencyKey,` (shorthand
        // property). Spread (`...meta`) is NOT accepted — if a site
        // uses spread, it must be explicitly allowlisted with rationale.
        const hasIdempotencyKey = /\bidempotencyKey\s*[:,}]/.test(argBlock)
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
          hasIdempotencyKey,
          argsSnippet,
        })
      }
    }
  }
  return sites
}

/**
 * Build the allowlist-key for a site. The format mirrors the values in
 * `BEST_EFFORT_DEDUP_ALLOWLIST` so the lookup is a simple `.has()`.
 */
function allowlistKey(site: CallSite): string {
  return `${site.file}:${site.callExpression}`
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("audit-2026-05-24 T7 — idempotency-key conformance", () => {
  // Cache the scan output across tests in this describe — the scan is
  // O(N) over the source tree and we run several assertions against it.
  // The cache also means the test suite stays sub-second.
  const sites = scanForWrapperCalls()

  it("every wrapper call site either supplies `idempotencyKey` OR is in the BEST_EFFORT_DEDUP_ALLOWLIST", () => {
    const violations: CallSite[] = []
    for (const site of sites) {
      if (site.hasIdempotencyKey) continue
      if (BEST_EFFORT_DEDUP_ALLOWLIST.has(allowlistKey(site))) continue
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
        `audit-2026-05-24 T7 — wrapper call site missing \`idempotencyKey\`.\n\n` +
          `Per SYNTHESIS.md §P0-7, every call to medusaAdjudicated / ` +
          `medusaStoreAdjudicated / stripeAdjudicated / twilioAdjudicated ` +
          `MUST either:\n` +
          `  (a) supply \`meta.idempotencyKey\` (or \`idempotencyKey\` as a ` +
          `sibling field for the medusaAdjudicated single-arg shape), OR\n` +
          `  (b) appear in BEST_EFFORT_DEDUP_ALLOWLIST in this test with a ` +
          `rationale comment.\n\n` +
          `Without one of (a) or (b), the wrapper falls back to ` +
          `\`randomUUID()\` for the envelope nonce; HTTP retries / WhatsApp ` +
          `resends / sweeper re-emits produce distinct intentHashes for the ` +
          `same logical operation and the kernel's Execution Ledger dedup ` +
          `silently fails.\n\n` +
          `New violations (${violations.length}):\n${lines}\n\n` +
          `If best-effort dedup is genuinely acceptable for the call site, ` +
          `add an entry to \`BEST_EFFORT_DEDUP_ALLOWLIST\` with the format ` +
          `\`<file>:<call-expression>\` and a comment explaining why ` +
          `(see existing allowlist entries for example rationales).`,
      )
    }
    expect(violations).toEqual([])
  })

  it("every BEST_EFFORT_DEDUP_ALLOWLIST entry references a site that actually exists (sentinel)", () => {
    // Sentinel against the allowlist rotting after a refactor. If a
    // call site is migrated to supply `idempotencyKey` (good!) but the
    // allowlist entry is left behind, the entry rots — a future developer
    // can't tell whether the deferral is still live. Force every
    // allowlist entry to map to an actual call site OR be removed.
    const observed: ReadonlySet<string> = new Set(
      sites.filter((s) => !s.hasIdempotencyKey).map(allowlistKey),
    )
    const stale: string[] = []
    for (const key of BEST_EFFORT_DEDUP_ALLOWLIST) {
      if (!observed.has(key)) stale.push(key)
    }
    if (stale.length > 0) {
      throw new Error(
        `BEST_EFFORT_DEDUP_ALLOWLIST contains stale entries — the call site ` +
          `no longer exists OR the call now supplies \`idempotencyKey\`. ` +
          `Either remove the entry (good — the migration is complete) or ` +
          `fix the file/call-expression pattern if it shifted.\n\n` +
          `Stale entries (${stale.length}):\n` +
          stale.map((s) => `  • ${s}`).join("\n"),
      )
    }
    expect(stale).toEqual([])
  })

  it("scan surface picks up at least one call site per governed wrapper (smoke test)", () => {
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

  it("scan completes in under 1 second (perf sentinel)", () => {
    // This conformance test must stay fast — it runs on every CI build.
    // The static scan over a few thousand files should complete in
    // well under a second. If this fails, the regex got pathological or
    // the scan surface grew unboundedly; investigate the largest files.
    const t0 = Date.now()
    scanForWrapperCalls()
    const elapsedMs = Date.now() - t0
    expect(elapsedMs).toBeLessThan(1000)
  })
})
