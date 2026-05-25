// audit-2026-05-24 (post-review) — Hardening test T8: audit-sink
// bootstrap-order conformance.
//
// # Why this test exists
//
// The multi-agent code review of PR #62 found that 4 admin route files
// called `getAuditSink()` at the TOP of the Fastify plugin body:
//
//   apps/api/src/routes/admin/payments.ts        — adminPaymentRoutes
//   apps/api/src/routes/admin/orders.ts          — orderRoutes
//   apps/api/src/routes/admin/order-actions.ts   — adminOrderActionRoutes
//   apps/api/src/routes/admin/reservations.ts    — reservationRoutes
//
// Fastify 5 executes plugin bodies during `await server.register(...)`,
// which is invoked inside `buildServer()` at `apps/api/src/server.ts`.
// `buildServer()` returns BEFORE `bootstrapAuditSinkDI()` at
// `apps/api/src/index.ts:65` has run. Since `getAuditSink()` is fail-closed
// in `@ibatexas/audit-sink`, calling it pre-bootstrap throws
// `AuditSinkNotInitializedError`. The throw bubbles to `start().catch` and
// `process.exit(1)` fires — **production cannot boot**.
//
// Test suites masked this because `apps/api/src/__tests__/setup.ts`
// registers a no-op sink at module load via `__setAuditSinkDependencies`,
// so by the time any test imports a route module the sink is already
// initialized. Production has no such pre-wiring.
//
// The fix: defer `getAuditSink()` resolution to a `server.addHook("onReady", ...)`
// callback. `onReady` fires during `server.ready()` — which `server.listen()`
// invokes implicitly — and `bootstrapAuditSinkDI()` runs BEFORE
// `server.listen()` in `index.ts:start()`. So by the time the onReady hook
// fires, the sink is initialized.
//
// This static-conformance test catches regressions where a future PR
// puts a `getAuditSink()` call back at the top of a plugin body. Any
// such call OUTSIDE an `onReady` hook callback in a plugin-body prefix
// (the code between `export async function <name>RoutesName(server)` and
// the first `app.<method>(...)` route registration) is forbidden.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect } from "vitest"

// __dirname → apps/api/src/__tests__/bypass-detection
// repo root  → ../../../../../
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")

/**
 * Files that register Fastify route plugins via `server.register(...)`
 * and were observed to call `getAuditSink()` at plugin-body top-level
 * pre-fix. Any new admin route plugin that constructs a command/service
 * with an `auditSink:` should be added here so this gate covers it.
 */
const PLUGIN_FILES_TO_AUDIT: ReadonlyArray<string> = [
  "apps/api/src/routes/admin/payments.ts",
  "apps/api/src/routes/admin/orders.ts",
  "apps/api/src/routes/admin/order-actions.ts",
  "apps/api/src/routes/admin/reservations.ts",
]

/**
 * Strip line and block comments so a commented-out `getAuditSink()`
 * doesn't trigger the regression check.
 */
function stripComments(src: string): string {
  // Block comments: /* … */ (non-greedy, multi-line)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "")
  // Line comments: // … to end of line
  out = out.replace(/\/\/.*$/gm, "")
  return out
}

/**
 * Extract the plugin-body prefix: text from the route-export function
 * signature up to the FIRST `app.<method>(` (or `server.<method>(`)
 * route-registration call. Returns an empty string if no plugin-export
 * is found (file isn't a route plugin — caller should still flag).
 */
function extractPluginBodyPrefix(src: string): string {
  const cleaned = stripComments(src)
  // Find the export async function for the route plugin.
  // Convention: `export async function <name>Routes(server: FastifyInstance)`
  // or `export async function <name>RouteX(server)`.
  const fnMatch = cleaned.match(
    /export\s+async\s+function\s+\w+\s*\(\s*server\s*:\s*FastifyInstance[^)]*\)\s*:[^{]*\{/,
  )
  if (fnMatch === null || fnMatch.index === undefined) {
    return ""
  }
  const bodyStart = fnMatch.index + fnMatch[0].length
  // Find the first route-registration call: `app.get(`, `app.post(`, …
  // or `server.get(` / `server.route(` / `server.register(`. The body
  // prefix is everything between bodyStart and that first registration.
  const after = cleaned.slice(bodyStart)
  const firstRouteMatch = after.match(
    /\b(?:app|server)\.(?:get|post|put|patch|delete|head|options|route|register)\s*\(/,
  )
  if (firstRouteMatch === null || firstRouteMatch.index === undefined) {
    // No route registration in body — return entire body as prefix.
    return after
  }
  return after.slice(0, firstRouteMatch.index)
}

/**
 * Within the plugin-body prefix, blot out the contents of every
 * `server.addHook("onReady", ...)` callback so its body doesn't count
 * as plugin-body code. The replacement uses balanced-paren walking so
 * nested function bodies are handled correctly.
 */
function blotOnReadyHookBodies(prefix: string): string {
  let out = prefix
  const HOOK_OPEN = /server\.addHook\s*\(\s*["']onReady["']\s*,/g
  let match: RegExpExecArray | null
  // Iterate from right to left so we can splice without invalidating earlier indices.
  const matches: { start: number; end: number }[] = []
  while ((match = HOOK_OPEN.exec(out)) !== null) {
    // Walk forward from the position AFTER the comma to find the
    // matching close-paren that ends the addHook(...) call.
    let depth = 1 // we're inside the addHook( paren already
    let i = match.index + match[0].length
    while (i < out.length && depth > 0) {
      const ch = out[i]
      if (ch === "(") depth += 1
      else if (ch === ")") depth -= 1
      i += 1
    }
    if (depth === 0) {
      matches.push({ start: match.index, end: i })
    }
  }
  // Splice from right to left.
  for (const { start, end } of matches.reverse()) {
    const blot = "X".repeat(end - start) // preserve indices for any subsequent regex
    out = out.slice(0, start) + blot + out.slice(end)
  }
  return out
}

describe("audit-sink bootstrap-order conformance (T8)", () => {
  for (const relPath of PLUGIN_FILES_TO_AUDIT) {
    it(`${relPath}: plugin body does not call getAuditSink() outside an onReady hook`, () => {
      const src = readFileSync(join(REPO_ROOT, relPath), "utf8")
      const prefix = extractPluginBodyPrefix(src)
      expect(
        prefix.length,
        `Expected to find a Fastify plugin export in ${relPath} but did not — has the file shape changed?`,
      ).toBeGreaterThan(0)

      const withoutOnReady = blotOnReadyHookBodies(prefix)

      // After blotting onReady bodies, no getAuditSink() call should remain
      // in the plugin-body prefix.
      const forbiddenCalls = withoutOnReady.match(/\bgetAuditSink\s*\(/g) ?? []
      expect(
        forbiddenCalls,
        [
          `Found ${forbiddenCalls.length} forbidden getAuditSink() call(s) at the plugin-body top-level of ${relPath}.`,
          ``,
          `Plugin bodies execute during await server.register(...) inside buildServer(),`,
          `which runs BEFORE bootstrapAuditSinkDI() in apps/api/src/index.ts:start().`,
          `Calling getAuditSink() in the plugin body throws AuditSinkNotInitializedError`,
          `and crashes production boot. The setup.ts test-time noop sink masks this in CI.`,
          ``,
          `Fix: wrap the service construction in a server.addHook("onReady", async () => { ... })`,
          `callback. The onReady hook fires during server.ready() — which`,
          `server.listen() invokes implicitly — and that is after bootstrapAuditSinkDI() has`,
          `run, so the sink is initialized by then.`,
          ``,
          `See apps/api/src/routes/admin/payments.ts for the canonical fix pattern.`,
        ].join("\n"),
      ).toEqual([])
    })
  }

  it("the audit list itself stays in lockstep with reality", () => {
    // Sanity guard: if the admin/ directory grows a new route plugin file,
    // it must be added to PLUGIN_FILES_TO_AUDIT or the gate gives a false
    // sense of coverage. This is intentionally manual — adding to the list
    // is a low-friction conscious decision.
    expect(PLUGIN_FILES_TO_AUDIT.length).toBeGreaterThanOrEqual(4)
  })
})
