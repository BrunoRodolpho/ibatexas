#!/usr/bin/env node
/**
 * F-53 reach guard — the audit-redaction chokepoint covers every workspace.
 *
 * WHAT THIS EXISTS TO PREVENT
 * ---------------------------
 * `@adjudicate/audit` publicly exports the raw sink primitives (multiSink,
 * multiSinkLossy, multiSinkStrict, createConsoleSink, createNatsSink,
 * bufferedSink, persistentBufferedSink). Every IbateXas audit emit must route
 * through `getAuditSink()` so the AuditRedactor scrubs PII before NATS and
 * Postgres see the record — an LGPD control, not a style preference.
 *
 * That invariant is enforced by a `no-restricted-imports` ban shipped in
 * @ibatexas/eslint-config. A lint rule only covers the workspaces that actually
 * inherit it, and two ways of losing it are silent:
 *
 *   1. A workspace declares its own `no-restricted-imports`. ESLint REPLACES
 *      rule options rather than merging them, so the base ban vanishes for that
 *      whole workspace. Measured during F-53: with the ban only in the base
 *      config, a probe importing `multiSink` inside apps/api linted CLEAN while
 *      the identical probe in packages/journeys errored — apps/api overrides.
 *   2. A workspace is built on some other base entirely (apps/web extends
 *      eslint-config-next, not @ibatexas/eslint-config) and never inherits it.
 *
 * Both leave the rule looking repo-wide while being dead where it matters, which
 * is the exact shape F-53 reported in the first place: a named gate asserted to
 * cover ground it structurally could not reach.
 *
 * WHY IT ASKS ESLINT INSTEAD OF READING THE CONFIG FILES
 * -----------------------------------------------------
 * A grep over `eslint.config.mjs` would only prove the text is present, and a
 * check derived from the same configs it is validating cannot fail
 * independently of them. This shells out to `eslint --print-config` INSIDE each
 * workspace, so what is measured is the rule that would actually fire on a real
 * file — including whatever overriding, ordering or extends-chain produced it,
 * resolved through that workspace's own toolchain exactly as `pnpm lint` does.
 *
 * WHY A ROOT SCRIPT AND NOT A PACKAGE TEST
 * ----------------------------------------
 * `turbo.json` declares `test` as CACHEABLE with package-scoped inputs. A
 * cross-workspace assertion living inside one package's suite is stale by
 * construction: measured during F-53, planting a bypass file in apps/src and
 * re-running `turbo test --filter=@ibatexas/audit-sink` reported FULL TURBO —
 * 2 cached, the suite never ran. This script is invoked directly by CI, so it
 * always executes against the working tree.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BANNED_MODULE = "@adjudicate/audit"

/**
 * The primitives every workspace's effective config must restrict. Written out
 * by hand rather than imported from the shared config: importing the list from
 * the thing under test would make this guard agree with any future edit,
 * including one that empties it.
 */
const REQUIRED_PRIMITIVES = [
  "multiSink",
  "multiSinkLossy",
  "multiSinkStrict",
  "createConsoleSink",
  "createNatsSink",
  "bufferedSink",
  "persistentBufferedSink",
]

/**
 * Workspaces intentionally outside the ban, each with a reason. Hand-written:
 * a workspace may only land here by a deliberate edit, never by the guard
 * inferring that coverage is missing and accommodating it. An entry naming a
 * workspace that does not exist is itself an error, so the list cannot rot
 * quietly into a blanket pass.
 *
 * Exempt nothing you have not first tried to cover: an earlier draft of this
 * guard pre-emptively exempted apps/commerce on the assumption that a Medusa
 * app runs its own toolchain, and running it showed apps/commerce extends
 * @ibatexas/eslint-config like everything else and is covered on its own merits.
 */
const EXEMPT = new Map([
  [
    "packages/eslint-config",
    "Defines the ban itself. CJS config package, no eslint.config.mjs and no importing source of its own; linted via the root `lint:scripts` pass.",
  ],
])

/**
 * Every workspace group declared in pnpm-workspace.yaml. `examples` matches
 * nothing today; it is listed so that adding an examples/* package puts it
 * under the ban instead of quietly outside it.
 */
const WORKSPACE_GROUPS = ["apps", "packages", "examples"]

/**
 * Discover workspaces by package.json — NOT by the presence of an
 * eslint.config.mjs. Keying discovery off the config file would make a
 * workspace that has no ESLint setup at all disappear from the roll call,
 * which is the one case most in need of reporting: no config means no rule,
 * and a silent skip would read as coverage.
 */
function discoverWorkspaces() {
  const found = []
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(REPO_ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(groupDir, entry.name)
      if (!existsSync(join(dir, "package.json"))) continue
      found.push({
        name: `${group}/${entry.name}`,
        dir,
        hasEslintConfig: existsSync(join(dir, "eslint.config.mjs")),
      })
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve the effective `no-restricted-imports` config for a representative
 * source file in `dir` and report which required primitives it restricts.
 */
function missingPrimitivesFor(dir) {
  // A path that does not need to exist — config resolution is path-based, and
  // using a non-existent file keeps the probe from matching a per-file
  // allowlist entry for some real source file.
  const probePath = join("src", "__f53_reach_probe__.ts")
  let raw
  try {
    raw = execFileSync("npx", ["eslint", "--print-config", probePath], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(
      `could not resolve eslint config: ${err.stderr?.toString().trim() || err.message}`,
    )
  }

  const config = JSON.parse(raw)
  const entry = config?.rules?.["no-restricted-imports"]
  if (!Array.isArray(entry) || entry.length < 2) return [...REQUIRED_PRIMITIVES]

  const severity = entry[0]
  if (severity !== "error" && severity !== 2) return [...REQUIRED_PRIMITIVES]

  const paths = entry[1]?.paths
  if (!Array.isArray(paths)) return [...REQUIRED_PRIMITIVES]

  const banned = paths.find((p) => p?.name === BANNED_MODULE)
  if (!banned) return [...REQUIRED_PRIMITIVES]

  const covered = new Set(banned.importNames ?? [])
  return REQUIRED_PRIMITIVES.filter((p) => !covered.has(p))
}

/**
 * The one file permitted to reach the raw primitives, relative to the repo
 * root. Mirrors AUDIT_COMPOSER_ALLOWLIST in
 * packages/audit-sink/eslint.config.mjs and is hand-written for the same
 * reason: it must not be derived from whichever files happen to import them.
 */
const COMPOSER_ALLOWLIST = ["packages/audit-sink/src/index.ts"]

/**
 * `no-restricted-imports` governs static `import` declarations — including
 * namespace imports, measured — but NOT `await import("...")`. ESLint has no
 * importNames-aware equivalent for an ImportExpression, and closing it with a
 * `no-restricted-syntax` selector would add a second rule carrying the same
 * replace-not-merge inheritance hazard across six configs. A source scan from
 * the root has repo-wide reach with no inheritance surface at all, so the
 * dynamic vector is closed here instead.
 */
function findDynamicImports() {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue
      if (entry.name.endsWith(".d.ts")) continue
      const rel = full.slice(REPO_ROOT.length + 1)
      if (COMPOSER_ALLOWLIST.includes(rel)) continue
      const src = readFileSync(full, "utf8")
      if (
        /\bimport\s*\(\s*["'`]@adjudicate\/audit["'`]\s*\)/.test(src) ||
        /\brequire\s*\(\s*["'`]@adjudicate\/audit["'`]\s*\)/.test(src)
      ) {
        offenders.push(rel)
      }
    }
  }
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(REPO_ROOT, group)
    if (existsSync(groupDir)) walk(groupDir)
  }
  return offenders
}

async function main() {
  const workspaces = discoverWorkspaces()
  const known = new Set(workspaces.map((w) => w.name))
  const failures = []

  // A stale exemption is a failure in its own right: it would otherwise sit
  // there excusing a workspace nobody can find.
  for (const [name, reason] of EXEMPT) {
    if (!known.has(name)) {
      failures.push(
        `exempt workspace "${name}" no longer exists (reason on file: ${reason}) — drop it from EXEMPT`,
      )
    }
  }

  const checked = []
  for (const ws of workspaces) {
    if (EXEMPT.has(ws.name)) continue
    checked.push(ws.name)
    if (!ws.hasEslintConfig) {
      failures.push(
        `${ws.name}: has no eslint.config.mjs, so no lint rule reaches it at all`,
      )
      continue
    }
    let missing
    try {
      missing = missingPrimitivesFor(ws.dir)
    } catch (err) {
      failures.push(`${ws.name}: ${err.message}`)
      continue
    }
    if (missing.length > 0) {
      failures.push(
        `${ws.name}: effective config does not restrict ${missing.join(", ")} from "${BANNED_MODULE}"`,
      )
    }
  }

  for (const file of findDynamicImports()) {
    failures.push(
      `${file}: dynamically imports "${BANNED_MODULE}", which the lint ban cannot see — route the emit through getAuditSink()`,
    )
  }

  if (failures.length > 0) {
    console.error(
      `\nF-53 reach guard FAILED — the audit-redaction import ban is not in effect everywhere:\n`,
    )
    for (const f of failures) console.error(`  - ${f}`)
    console.error(
      `\nFix: extend @ibatexas/eslint-config, or splice AUDIT_RAW_SINK_IMPORT_BAN from\n` +
        `@ibatexas/eslint-config/restricted-imports.js into that workspace's own\n` +
        `no-restricted-imports paths (ESLint replaces rule options, it does not merge them).\n`,
    )
    process.exit(1)
  }

  console.log(
    `F-53 reach guard OK — audit-sink import ban in effect across ${checked.length} workspaces ` +
      `(${EXEMPT.size} exempt): ${checked.join(", ")}`,
  )
}

main().catch((err) => {
  console.error("F-53 reach guard errored:", err)
  process.exit(1)
})
