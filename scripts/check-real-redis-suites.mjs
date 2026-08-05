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
const JOURNEYS_DIR = path.join(REPO_ROOT, "packages", "journeys")

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
  // F-21 CLASS ROLLOUT — the three sites the #514 census named and deferred.
  // Each drives PRODUCTION code against a container and carries an in-test
  // CONTROL running the pre-fix release verbatim in the same end state.
  //
  // Site 1 (checkout/money): the `checkout:idem:<token>` single-flight gate.
  // 8 cases — the F-21 sequence, self-release, key+TTL, the 409 condition, the
  // UUID token, distinct tokens, a 25-way storm, and the unconditional-DEL control.
  { file: "src/__tests__/checkout-idem-gate-ownership.test.ts", minExecuted: 8, realRedis: 8 },
  // Site 2: the agent trigger redelivery + cooldown claims. 8 cases — owned
  // release, lapsed+foreign left alone, the tokens, the promote window, the
  // pre-F-21 control, and three on `compareAndDelete` itself (incl. a 40-way
  // atomicity race).
  { file: "src/__tests__/agent-trigger-dedup-ownership.test.ts", minExecuted: 8, realRedis: 8 },
  // Site 3: `releaseWebAgentLock`'s no-tracked-state fallback. 6 cases — the
  // key survives, the warn is emitted, the owned path is unchanged (two ways),
  // the second-release shape, and the pre-F-21 control.
  {
    file: "src/streaming/__tests__/execution-queue-release-fallback.test.ts",
    minExecuted: 6,
    realRedis: 6,
  },
  // 3 cases, of which 1 is inside the RUN_REAL_REDIS describe.
  { file: "src/__tests__/ledger-replay-suppression.test.ts", minExecuted: 3, realRedis: 1 },
  { file: "src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts", minExecuted: 3, realRedis: 3 },
  // ── M1 — THE SCRIPT-SHAPE CONTRACT SUITES (Q2) ─────────────────────────────
  //
  // Everything above this line is a SITE suite: it drives one call site's
  // production functions. The four below are SHAPE suites — each reads the Lua
  // TEXT out of every production site that runs that shape (via
  // `helpers/lua-script-sources.ts`) and runs one contract against all of them
  // on a real Redis. They are what licenses Q2's "call sites inherit the shape's
  // invariant from the contract suite": the contract runs the site's own bytes,
  // so a divergent copy reds at that site's row whether or not the site has a
  // suite of its own.
  //
  // Each carries a per-site CONTROL that removes the shape's conjunct from that
  // site's own script and requires the damage to appear — so a case that stopped
  // testing anything cannot stay green.
  //
  // CAD, 11 sites (the census inventory said 10; it missed
  // claustrum/trigger-dedup-redis.ts). 2 population/extractor cases + 11
  // contract + 11 conjunct-removal controls + 2 atomicity + 1 shape identity.
  { file: "src/__tests__/lua-shape-cad-contract.test.ts", minExecuted: 27, realRedis: 24 },
  // CONSUME, 4 sites. 1 population + 4 contract + 4 atomicity + 4 non-atomic
  // controls + 1 shape identity + 1 CAD/CONSUME family-confusion case.
  { file: "src/__tests__/lua-shape-consume-contract.test.ts", minExecuted: 15, realRedis: 13 },
  // CAE, 3 sites (2 EXPIRE/seconds, 1 PEXPIRE/ms). 1 population + 3 contract +
  // 3 unit + 3 conjunct-removal controls + 1 heartbeat scenario + 1 identity.
  { file: "src/__tests__/lua-shape-cae-contract.test.ts", minExecuted: 12, realRedis: 10 },
  // Rate limit, 2 sites (different scripts, same conjunct: INCR and the TTL-set
  // are indivisible). 1 population + 2 immortality + 2 conjunct-removal
  // controls + 2 non-atomic controls + 2 concurrency + 3 plugin-window cases.
  { file: "src/__tests__/lua-shape-rate-limit-contract.test.ts", minExecuted: 12, realRedis: 11 },
  // WhatsApp session rollover, 1 site. 6 boundary/stamping cases + 1 burst
  // atomicity + 1 non-atomic control + 1 conjunct-removal control + 1 blast
  // radius. `now` and the idle threshold are both ARGV, so no sleeps.
  {
    file: "src/__tests__/lua-shape-session-rollover-contract.test.ts",
    minExecuted: 10,
    realRedis: 10,
  },
  // Token bucket, 1 site — the only shape whose script does arithmetic, so the
  // contract is a refill CURVE. 5 curve/boundary cases + 1 concurrency + 1
  // non-atomic control + 2 TTL (incl. the conjunct-removal control) + 1 state
  // round-trip. `now` is ARGV, so no sleeps.
  {
    file: "src/__tests__/lua-shape-token-bucket-contract.test.ts",
    minExecuted: 10,
    realRedis: 10,
  },
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

/**
 * THE ROLL CALL FOR `packages/journeys` — M2.
 *
 * Until M2 this gate only ever looked at `apps/api`, because that is where
 * every real-Redis suite lived. M2's retirement of census class (i) item 7
 * moved `journey-lock.test.ts` onto a real Redis container in ANOTHER package,
 * and a suite that can skip in a directory the gate does not scan is precisely
 * the hole M0 closed — reopened one package over. So the gate now walks a list
 * of packages, and this is the second entry.
 *
 * 9 cases: 3 same-journey contention, 1 distinct-keys, 3 ownership-checked
 * release, 2 heartbeat. All container-backed.
 */
const JOURNEYS_ROLL_CALL = [
  { file: "src/runner/__tests__/journey-lock.test.ts", minExecuted: 9, realRedis: 9 },
]

/**
 * The packages this gate polices, each with its own hand-written roll call.
 * `scan` is the tree the completeness alarm walks for that package.
 */
const PACKAGES = [
  {
    name: "apps/api",
    dir: API_DIR,
    scan: "apps/api/src",
    rollCall: ROLL_CALL,
    exclusions: EXCLUSIONS,
  },
  {
    name: "packages/journeys",
    dir: JOURNEYS_DIR,
    scan: "packages/journeys/src",
    rollCall: JOURNEYS_ROLL_CALL,
    exclusions: [],
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

const outDir = mkdtempSync(path.join(tmpdir(), "ibx-real-redis-gate-"))

for (const pkg of PACKAGES) {
  // ── 1. Every enumerated file must still exist ──────────────────────────────
  // A rename that silently drops a suite from the run is the failure mode this
  // catches: without it, the vitest invocation below would just not match the
  // path and could be argued away as "no results for that file".
  for (const { file } of pkg.rollCall) {
    if (!existsSync(path.join(pkg.dir, file))) {
      fail(
        `ROLL CALL names a file that does not exist: ${pkg.name}/${file}\n` +
          `      If the suite was renamed or retired, update the roll call in ` +
          `scripts/check-real-redis-suites.mjs deliberately.`,
      )
    }
  }

  // ── 2. Completeness alarm (adds requirements only; never satisfies one) ────
  // --others --exclude-standard so a real-Redis suite that is written but not
  // yet committed is caught by the author, not left for CI to miss.
  const ls = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", pkg.scan],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
  let discovered = []
  if (ls.status !== 0) {
    fail(
      `completeness alarm could not list files for ${pkg.name}: ${ls.stderr || ls.stdout}`,
    )
  } else {
    discovered = ls.stdout
      .split("\n")
      .filter((p) => p.endsWith(".ts"))
      .map((p) => p.replace(new RegExp(`^${pkg.name}/`), ""))
      .filter((rel) => {
        const abs = path.join(pkg.dir, rel)
        if (!existsSync(abs)) return false
        const src = readFileSync(abs, "utf8")
        return REAL_REDIS_MARKERS.some((m) => src.includes(m))
      })
  }

  const known = new Set([
    ...pkg.rollCall.map((r) => r.file),
    ...pkg.exclusions.map((e) => e.file),
  ])
  const unlisted = discovered.filter((f) => !known.has(f))
  if (unlisted.length > 0) {
    fail(
      `real-Redis suite(s) not accounted for in this gate:\n` +
        unlisted.map((f) => `        ${pkg.name}/${f}`).join("\n") +
        `\n      Add each to that package's roll call (with the count of cases` +
        `\n      that must execute) or to its exclusions with a reason. An` +
        `\n      unlisted real-Redis suite can skip in CI without anything` +
        `\n      noticing — the exact hole M0 closes.`,
    )
  }

  // ── 3. Drive the suites for real and read what actually executed ───────────
  const outFile = path.join(outDir, `${pkg.name.replace(/\//g, "-")}.json`)

  console.log(
    `[real-redis-gate] driving the enumerated real-Redis suites from ${pkg.name} …`,
  )
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${outFile}`,
      ...pkg.rollCall.map((r) => r.file),
    ],
    { cwd: pkg.dir, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
  )

  if (!existsSync(outFile)) {
    fail(
      `vitest produced no JSON report for ${pkg.name} (exit ${run.status}). The suites ` +
        `did not run at all — treat this as the zero-count failure this gate exists to raise.`,
    )
    continue
  }

  const report = JSON.parse(readFileSync(outFile, "utf8"))
  const byFile = new Map()
  for (const tr of report.testResults ?? []) {
    byFile.set(path.relative(pkg.dir, tr.name), tr.assertionResults ?? [])
  }

  console.log(`\n[real-redis-gate] ${pkg.name} — executed cases per enumerated suite:`)
  for (const { file, minExecuted } of pkg.rollCall) {
    const results = byFile.get(file)
    if (results === undefined) {
      fail(`no vitest result at all for ${pkg.name}/${file} — the suite never ran.`)
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
        `${pkg.name}/${file}: ${executed} case(s) executed, roll call requires >= ${minExecuted}.\n` +
          `      ${executed === 0 ? "ZERO executed — the suite skipped wholesale." : "Cases went missing."}`,
      )
    }
    if (skipped > 0) {
      fail(
        `${pkg.name}/${file}: ${skipped} case(s) SKIPPED. Real-Redis coverage may not be ` +
          `silently opted out of; remove the skip or amend the roll call on purpose.`,
      )
    }
    if (failed > 0) {
      fail(`${pkg.name}/${file}: ${failed} case(s) FAILED (see the vitest output above).`)
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

const allRows = PACKAGES.flatMap((p) => p.rollCall)
const totalExecuted = allRows.reduce((n, r) => n + r.minExecuted, 0)
const totalRealRedis = allRows.reduce((n, r) => n + r.realRedis, 0)
console.log(
  `\n✅ real-Redis loud-skip gate PASSED: ${allRows.length} enumerated suites ran across ` +
    `${PACKAGES.length} package(s), >= ${totalExecuted} cases executed ` +
    `(${totalRealRedis} of them container-backed), 0 skipped.\n`,
)
