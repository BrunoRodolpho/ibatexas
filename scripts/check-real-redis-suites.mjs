#!/usr/bin/env node
/**
 * M0 loud-skip gate — the multi()/eval ruling's Q1 precondition.
 * See docs/architecture/redis-lua-testing-decision.md.
 *
 * WHAT THIS EXISTS TO PREVENT
 * ---------------------------
 * A `describe.skipIf(...)` that evaluates false in CI reports the file as
 * PASSED. Measured on dev @ 2f5c4979, the required `check` job printed:
 *
 *     ✓ src/__tests__/park-deferred-intent-nx.test.ts   (4 tests | 3 skipped)
 *     ✓ src/__tests__/otp-brute-force-atomic.test.ts    (5 tests | 4 skipped)
 *     ✓ src/__tests__/refund-drip-cap-atomic.test.ts    (4 tests | 3 skipped)
 *     ✓ src/__tests__/refund-drip-cap-before.test.ts    (2 tests | 1 skipped)
 *     ✓ src/__tests__/otp-brute-force-before.test.ts    (2 tests | 1 skipped)
 *
 * Twelve real-Redis cases never ran, and CI was green. The ruling routes the
 * repo's Lua-atomicity coverage through real Redis, so that shape has to
 * become impossible before any of it lands.
 *
 * WHY A SEPARATE VITEST INVOCATION AND NOT A PARSE OF `turbo test`
 * ---------------------------------------------------------------
 * `turbo.json` declares `test` as CACHEABLE. A gate that reads a report
 * produced by the cached task would happily certify "these suites ran" on a
 * cache HIT, in which case they demonstrably did not — the same green lie one
 * layer up. This step drives vitest itself, so a pass here means the
 * containers really started in THIS job.
 *
 * WHY THE ROLL CALL IS HAND-WRITTEN
 * ---------------------------------
 * A gate whose expectations are derived from the same mechanism it polices
 * cannot fail: enumerate the suites by asking "which files are gated?" and
 * deleting a gate deletes its own coverage requirement. So `ROLL_CALL` below
 * is typed out by hand — file names AND the per-file count of real-Redis
 * cases that must actually execute. Deleting a case, or letting a suite skip,
 * reds this gate and forces an explicit, reviewed edit to this file.
 *
 * `discoverRealRedisSuites()` DOES read the source tree, but it can only ever
 * ADD a requirement (an un-enumerated real-Redis suite is an error). It can
 * never satisfy one. That asymmetry is the whole point — it is an alarm for
 * suites added later (the ruling's M1 adds eight), not the gate's evidence.
 *
 * USAGE
 *   node scripts/check-real-redis-suites.mjs
 * Run from the repo root. Requires a reachable Docker daemon (ci.yml probes
 * `docker info` before the test step for exactly this reason).
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const API_DIR = path.join(REPO_ROOT, "apps", "api")

/**
 * THE ROLL CALL — hand-written, not derived.
 *
 * `minExecuted` is the number of cases in that file that must be OBSERVED
 * EXECUTING; `realRedis` records how many of those actually talk to a Redis
 * container (they differ only for ledger-replay-suppression, which mixes one
 * container-backed case with two pure ones). `minExecuted` is a FLOOR, so
 * adding cases to a listed file keeps the gate green and ordinary test growth
 * never touches this file. Removing a case, or letting one skip, reds it.
 *
 * The floor alone would not pin the real-Redis subset of a mixed file — two
 * non-Redis cases could satisfy a floor of 3 while the container-backed one
 * skipped. The `skipped === 0` rule below is what closes that: it makes every
 * enumerated case load-bearing regardless of what it touches.
 */
const ROLL_CALL = [
  // Migrated onto the shared harness by M0 (were self-gated on REDIS_TEST_URL).
  { file: "src/__tests__/park-deferred-intent-nx.test.ts", minExecuted: 3, realRedis: 3 },
  { file: "src/__tests__/otp-brute-force-atomic.test.ts", minExecuted: 4, realRedis: 4 },
  { file: "src/__tests__/otp-brute-force-before.test.ts", minExecuted: 1, realRedis: 1 },
  { file: "src/__tests__/refund-drip-cap-atomic.test.ts", minExecuted: 3, realRedis: 3 },
  { file: "src/__tests__/refund-drip-cap-before.test.ts", minExecuted: 1, realRedis: 1 },
  // Already on the shared harness before M0.
  { file: "src/adapters/__tests__/park-deferred-intent-nx-hash.test.ts", minExecuted: 3, realRedis: 3 },
  // F-21 (PR #514), landed on dev while M0 was in review. Enumerated here
  // because the completeness alarm below flagged it in CI — the first live
  // catch, and the reason that alarm exists.
  { file: "src/__tests__/cart-create-lock-ownership.test.ts", minExecuted: 6, realRedis: 6 },
  // F-22 (#519, merged after this branch's last rebase) — the park-nx release
  // failure-mode suite: CAD-failure leaves the key to TTL; ownership-checked
  // release; the pre-F-22 control. Enrolled at merge time by the governor —
  // exactly the arrival class the discovery alarm below exists to catch.
  { file: "src/__tests__/park-nx-release-failure-mode.test.ts", minExecuted: 9, realRedis: 9 },
  // Phase 5 — the first of the two F-22-deferred migrations. The T5
  // audit-chain suite came off its hand-rolled in-memory stub: it parks
  // through `createParkRedisCapabilities()` (so the framework's ATOMIC quota
  // branch runs) and resumes through the resolver, whose `defer:resuming:*`
  // release is a real Lua compare-and-delete. Its 3 audit-chain cases now
  // assert over bytes Redis actually stored.
  {
    file: "src/__tests__/audit-2026-05-24/defer-resume-integrity.test.ts",
    minExecuted: 3,
    realRedis: 3,
  },
  // 3 cases, of which 1 is inside the RUN_REAL_REDIS describe.
  { file: "src/__tests__/ledger-replay-suppression.test.ts", minExecuted: 3, realRedis: 1 },
  { file: "src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts", minExecuted: 3, realRedis: 3 },
]

/**
 * Files the discovery scan will see that are deliberately NOT in the roll
 * call. Every entry needs a reason, so an omission is a decision on the
 * record rather than an oversight.
 */
const EXCLUSIONS = [
  {
    file: "src/__tests__/helpers/redis-testcontainer.ts",
    why: "the harness itself, not a suite",
  },
  {
    file: "src/__tests__/helpers/claustrum-bootstrap-harness.ts",
    why: "a helper, not a suite; its consumers are covered by the note below",
  },
  {
    file: "src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts",
    why: "calls setupRedisTestContainer() with NO skipIf — it cannot skip silently, it fails hard when Docker is absent, so it is already loud",
  },
  {
    file: "src/routes/admin/__tests__/force-routes-governance.test.ts",
    why: "same: unconditional setupRedisTestContainer(), already loud, and re-running its 61 cases here would double a large suite for no added signal",
  },
  // The RUN_BOOTSTRAP_HARNESS cluster (claustrum-bootstrap-*.test.ts,
  // scripted-pipeline.test.ts) also reads IBX_SKIP_REAL_REDIS, via
  // helpers/claustrum-bootstrap-harness.ts. It is excluded because those
  // suites ALSO need a Postgres container plus `prisma migrate deploy` — a
  // different cost class to re-run here. They are not left unpoliced: the
  // only way to silence them is IBX_SKIP_REAL_REDIS=1 or
  // IBX_SKIP_REAL_POSTGRES=1, and the first reds this gate, so the knob
  // cannot be flipped in CI without CI saying so.
  {
    file: "src/__tests__/claustrum-bootstrap-safe-unknown.test.ts",
    why: "RUN_BOOTSTRAP_HARNESS cluster — needs Postgres + prisma migrate; see note above",
  },
  {
    file: "src/__tests__/claustrum-bootstrap-claims-seams.test.ts",
    why: "RUN_BOOTSTRAP_HARNESS cluster — needs Postgres + prisma migrate; see note above",
  },
  {
    file: "src/__tests__/claustrum-bootstrap-reset.test.ts",
    why: "RUN_BOOTSTRAP_HARNESS cluster — needs Postgres + prisma migrate; see note above",
  },
  {
    file: "src/__tests__/scripted-pipeline/scripted-pipeline.test.ts",
    why: "RUN_BOOTSTRAP_HARNESS cluster — needs Postgres + prisma migrate; see note above",
  },
]

/** Markers that make a file a real-Redis suite. Used ONLY by the alarm. */
const REAL_REDIS_MARKERS = [
  "setupRedisTestContainer",
  "RUN_REAL_REDIS",
  "RUN_BOOTSTRAP_HARNESS",
]

const failures = []
const fail = (msg) => failures.push(msg)

// ── 1. Every enumerated file must still exist ────────────────────────────────
// A rename that silently drops a suite from the run is the failure mode this
// catches: without it, the vitest invocation below would just not match the
// path and could be argued away as "no results for that file".
for (const { file } of ROLL_CALL) {
  if (!existsSync(path.join(API_DIR, file))) {
    fail(
      `ROLL CALL names a file that does not exist: apps/api/${file}\n` +
        `      If the suite was renamed or retired, update ROLL_CALL in ` +
        `scripts/check-real-redis-suites.mjs deliberately.`,
    )
  }
}

// ── 2. Completeness alarm (adds requirements only; never satisfies one) ──────
function discoverRealRedisSuites() {
  // --others --exclude-standard so a real-Redis suite that is written but not
  // yet committed is caught by the author, not left for CI to miss.
  const ls = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "apps/api/src"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
  if (ls.status !== 0) {
    fail(`completeness alarm could not list files: ${ls.stderr || ls.stdout}`)
    return []
  }
  return ls.stdout
    .split("\n")
    .filter((p) => p.endsWith(".ts"))
    .map((p) => p.replace(/^apps\/api\//, ""))
    .filter((rel) => {
      const abs = path.join(API_DIR, rel)
      if (!existsSync(abs)) return false
      const src = readFileSync(abs, "utf8")
      return REAL_REDIS_MARKERS.some((m) => src.includes(m))
    })
}

const known = new Set([...ROLL_CALL.map((r) => r.file), ...EXCLUSIONS.map((e) => e.file)])
const unlisted = discoverRealRedisSuites().filter((f) => !known.has(f))
if (unlisted.length > 0) {
  fail(
    `real-Redis suite(s) not accounted for in this gate:\n` +
      unlisted.map((f) => `        apps/api/${f}`).join("\n") +
      `\n      Add each to ROLL_CALL (with the count of cases that must execute)` +
      `\n      or to EXCLUSIONS with a reason. An unlisted real-Redis suite can` +
      `\n      skip in CI without anything noticing — the exact hole M0 closes.`,
  )
}

// ── 3. Drive the suites for real and read what actually executed ─────────────
const outDir = mkdtempSync(path.join(tmpdir(), "ibx-real-redis-gate-"))
const outFile = path.join(outDir, "results.json")

console.log("[real-redis-gate] driving the enumerated real-Redis suites from apps/api …")
const run = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${outFile}`,
    ...ROLL_CALL.map((r) => r.file),
  ],
  { cwd: API_DIR, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
)

if (!existsSync(outFile)) {
  fail(
    `vitest produced no JSON report (exit ${run.status}). The suites did not run at all — ` +
      `treat this as the zero-count failure this gate exists to raise.`,
  )
} else {
  const report = JSON.parse(readFileSync(outFile, "utf8"))
  const byFile = new Map()
  for (const tr of report.testResults ?? []) {
    byFile.set(path.relative(API_DIR, tr.name), tr.assertionResults ?? [])
  }

  console.log("\n[real-redis-gate] executed cases per enumerated suite:")
  for (const { file, minExecuted } of ROLL_CALL) {
    const results = byFile.get(file)
    if (results === undefined) {
      fail(`no vitest result at all for apps/api/${file} — the suite never ran.`)
      continue
    }
    const executed = results.filter(
      (a) => a.status === "passed" || a.status === "failed",
    ).length
    const skipped = results.filter(
      (a) => a.status === "skipped" || a.status === "pending" || a.status === "todo",
    ).length
    const failed = results.filter((a) => a.status === "failed").length

    const verdict =
      executed >= minExecuted && skipped === 0 && failed === 0 ? "OK  " : "FAIL"
    console.log(
      `  ${verdict} ${file}: executed=${executed} (need >= ${minExecuted}), ` +
        `skipped=${skipped}, failed=${failed}`,
    )

    if (executed < minExecuted) {
      fail(
        `apps/api/${file}: ${executed} case(s) executed, roll call requires >= ${minExecuted}.\n` +
          `      ${executed === 0 ? "ZERO executed — the suite skipped wholesale." : "Cases went missing."}`,
      )
    }
    if (skipped > 0) {
      fail(
        `apps/api/${file}: ${skipped} case(s) SKIPPED. Real-Redis coverage may not be ` +
          `silently opted out of; remove the skip or amend the roll call on purpose.`,
      )
    }
    if (failed > 0) {
      fail(`apps/api/${file}: ${failed} case(s) FAILED (see the vitest output above).`)
    }
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("\n❌ real-Redis loud-skip gate FAILED:\n")
  for (const f of failures) console.error(`  • ${f}`)
  console.error(
    "\n  Real-Redis suites carry the Lua-atomicity invariants (lock release, " +
      "\n  single-use consume, rate-limit windows). A green run in which they did " +
      "\n  not execute is the failure this gate exists to make loud." +
      "\n  Ruling: docs/architecture/redis-lua-testing-decision.md (Q1).\n",
  )
  process.exit(1)
}

const totalExecuted = ROLL_CALL.reduce((n, r) => n + r.minExecuted, 0)
const totalRealRedis = ROLL_CALL.reduce((n, r) => n + r.realRedis, 0)
console.log(
  `\n✅ real-Redis loud-skip gate PASSED: ${ROLL_CALL.length} enumerated suites ran, ` +
    `>= ${totalExecuted} cases executed (${totalRealRedis} of them container-backed), 0 skipped.\n`,
)
