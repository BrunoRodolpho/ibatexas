import fs from "node:fs"
import path from "node:path"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { execa, execaSync } from "execa"
import { ROOT } from "../utils/root.js"
import { DEV_FLAGS } from "../lib/dev-flags.js"
import {
  DEV_SUPERVISOR_LOG,
  disposableLogPath,
  logFileArgs,
} from "../lib/process-compose-log.js"
import type { ServiceDef } from "../services.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve short filter names to full pnpm package names.
 *  "ibx" | "cli" → "@ibatexas/cli", "web" → "@ibatexas/web", etc.
 *  Already-scoped names ("@ibatexas/cli") pass through unchanged. */
function resolveFilter(filter: string): string {
  if (filter.startsWith("@")) return filter
  const alias = filter === "ibx" ? "cli" : filter
  const candidate = `@ibatexas/${alias}`
  const dirs = [
    path.join(ROOT, "packages", alias),
    path.join(ROOT, "apps", alias),
  ]
  if (dirs.some((d) => fs.existsSync(d))) return candidate
  return filter
}

const PC_YAML = path.join(ROOT, "process-compose.yaml")

/** Valid process names in process-compose.yaml (excluding one-shots) */
const APP_SERVICES = ["commerce", "api", "web", "admin", "qa-viewer", "adj-console", "adjutant"] as const

// ── process-compose detection ────────────────────────────────────────────────

async function checkProcessCompose(): Promise<boolean> {
  try {
    // BKL-288: `version` initialises the logger and TRUNCATES process-compose's
    // shared default log. `dev stop` / `dev restart` run this probe while the
    // supervisor is LIVE, so without an own log path the probe wipes the very
    // log you are about to read. Throwaway path — nothing ever reads it.
    await execa(
      "process-compose",
      ["version", ...logFileArgs(disposableLogPath("version-probe"))],
      { reject: true },
    )
    return true
  } catch {
    return false
  }
}

function requireProcessCompose(installed: boolean): void {
  if (installed) return
  console.error(chalk.red("\n  process-compose is not installed.\n"))
  console.error(chalk.white("  Install it with:"))
  console.error(chalk.cyan("    brew install f1bonacc1/tap/process-compose\n"))
  console.error(chalk.gray("  See https://github.com/F1bonacc1/process-compose"))
  process.exit(1)
}

// ── Ghost process detection ──────────────────────────────────────────────────

function getPortPids(port: number): number[] {
  try {
    const { stdout } = execaSync("lsof", ["-ti", `:${port}`], { reject: false })
    return (stdout ?? "").toString().trim().split("\n").filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function checkGhostProcesses(ports: number[]): void {
  const ghosts: { port: number; pids: number[] }[] = []
  for (const port of ports) {
    const pids = getPortPids(port)
    if (pids.length > 0) ghosts.push({ port, pids })
  }

  if (ghosts.length === 0) return

  console.error(chalk.yellow("\n  Ghost processes detected on service ports:\n"))
  for (const g of ghosts) {
    console.error(chalk.yellow(`    Port ${g.port}: PIDs ${g.pids.join(", ")}`))
  }
  console.error(chalk.white("\n  Run ") + chalk.cyan("ibx dev stop -f") + chalk.white(" to clean up, then retry.\n"))
  process.exit(1)
}

// ── Cross-repo preflight (non-mutating) ──────────────────────────────────────

/** Warn (never mutate) when a cross-repo service (adj-console / adjutant, both
 *  in ../adjudicate) is about to start but that sibling repo isn't installed.
 *  Reminds the developer to run `ibx bootstrap`. Purely advisory — the dev
 *  stack still launches so the same-repo services come up regardless. */
function preflightCrossRepo(processes: string[]): void {
  const all = processes.length === 0
  const wantsCrossRepo = all || processes.some((p) => p === "adj-console" || p === "adjutant")
  if (!wantsCrossRepo) return

  const adjudicateModules = path.join(ROOT, "..", "adjudicate", "node_modules")
  if (fs.existsSync(adjudicateModules)) return

  console.log(chalk.yellow("\n  Cross-repo preflight:") +
    chalk.white(" ../adjudicate/node_modules is missing."))
  console.log(chalk.gray("    The adj-console (:5180) + adjutant (:5182) surfaces will fail to start."))
  console.log(chalk.gray("    Install the sibling repo first: ") +
    chalk.cyan("cd ../adjudicate && pnpm install") +
    chalk.gray("  (or ") + chalk.cyan("ibx bootstrap") + chalk.gray(").\n"))
}

// ── process-compose start ────────────────────────────────────────────────────

interface StartOpts {
  skipDocker?: boolean
  noDocker?: boolean
  tui: boolean
  withTunnel?: boolean
  withStripe?: boolean
  /** commander `--no-observability`: true (default) keeps the obs one-shot. */
  observability?: boolean
  yes?: boolean
}

/** Default dev-stack process set. `observability` is a DEFAULT member: it brings
 *  up VictoriaLogs, which is the only place zero-call funnel turns
 *  (L0/L1/L2-fallback/ALIAS) are ever recorded — those write NO turn_trace row by
 *  design, so the pino line IS the record and an outage loses them permanently
 *  (never-written, not late). Exported so the drift test can prove
 *  CORE + tunnel + stripe covers every process declared in process-compose.yaml,
 *  which is what makes the `all` + opt-out expansion below faithful. */
export const CORE_PROCESSES = [
  "infra", "observability", "build-packages",
  "commerce", "api", "web-clean", "web", "admin-clean", "admin",
  "qa-viewer", "adj-console", "adjutant",
] as const

/** The two opt-in processes `all` adds on top of CORE_PROCESSES. */
export const OPTIONAL_PROCESSES = ["tunnel", "stripe"] as const

/** Resolve which process-compose processes to launch from the requested
 *  services + flags:
 *    named args → only those (process-compose resolves deps)
 *    "all"      → no filter (starts everything including tunnel/stripe)
 *    default    → core only, optionally + tunnel/stripe via flags
 *  Docker one-shots (`infra`, `observability`) are dropped when skipping Docker.
 *  Exported for unit testing — the default-membership of `observability` was
 *  entirely unpinned before BKL-266. */
export function resolveProcessList(
  services: string[],
  opts: StartOpts,
  skipDocker: boolean | undefined,
): string[] {
  const isAll = services.includes("all")
  const named = services.filter((s) => s !== "all")
  const optOutObservability = opts.observability === false

  let processes: string[]

  if (named.length > 0) {
    processes = named
  } else if (isAll) {
    // Normally an empty filter (= start every process in the YAML). With the
    // opt-out we must MATERIALIZE the set, since "everything except one" cannot
    // be expressed as an empty filter. CORE + OPTIONAL is proven equal to the
    // YAML's process set by the drift test, so the two paths stay equivalent.
    processes = optOutObservability ? [...CORE_PROCESSES, ...OPTIONAL_PROCESSES] : []
  } else {
    processes = [...CORE_PROCESSES]
    if (opts.withTunnel) processes.push("tunnel")
    if (opts.withStripe) processes.push("stripe")
  }

  if (skipDocker) {
    // Both `infra` and `observability` are docker one-shots — drop both.
    for (const dockerProc of ["infra", "observability"]) {
      const idx = processes.indexOf(dockerProc)
      if (idx !== -1) processes.splice(idx, 1)
    }
  }

  // BKL-266 — dedicated opt-out. Before this the ONLY way to skip the obs stack
  // was --skip-docker, which also drops `infra`: "Postgres is already running"
  // and "I don't want VictoriaLogs" were the same switch, so the evidence
  // channel got dropped as a side effect of an unrelated choice. Skipping it is
  // now an explicit, separate decision.
  if (optOutObservability) {
    const idx = processes.indexOf("observability")
    if (idx !== -1) processes.splice(idx, 1)
  }

  return processes
}

/** Confirm before launching. Returns true (start) with --yes or when
 *  non-interactive (CI / piped stdin) so scripts don't hang on a prompt;
 *  otherwise prompts, treating Ctrl+C / Esc at the prompt as a decline. */
async function confirmStart(opts: StartOpts): Promise<boolean> {
  if (opts.yes || !process.stdin.isTTY) return true
  const { confirm } = await import("@inquirer/prompts")
  try {
    return await confirm({ message: "Start the dev stack?", default: true })
  } catch {
    // Ctrl+C / Esc at the prompt
    return false
  }
}

/** argv for THE live dev supervisor.
 *
 *  BKL-288: the `-L` pair is load-bearing, not cosmetic. Without it the
 *  supervisor writes to process-compose's shared `process-compose-$USER.log`
 *  default, which every OTHER invocation on the machine (a `--dry-run`
 *  validation, a `version` probe, the test-stack supervisor) truncates on
 *  startup — silently destroying the running stack's forensic log. An explicit
 *  stable path is the only way the live log stops being collateral. */
export function buildPcUpArgs(processes: string[], tui?: boolean): string[] {
  const args = ["up", "-f", PC_YAML, ...logFileArgs(DEV_SUPERVISOR_LOG)]
  if (!tui) args.push("-t=false")
  args.push(...processes)
  return args
}

async function pcStart(
  services: string[],
  opts: StartOpts,
): Promise<void> {
  const installed = await checkProcessCompose()
  requireProcessCompose(installed)

  if (!fs.existsSync(PC_YAML)) {
    console.error(chalk.red(`\n  Missing ${PC_YAML}\n`))
    process.exit(1)
  }

  // Determine which service ports to check for ghosts
  const { SERVICES } = await import("../services.js")
  const portsToCheck = Object.values(SERVICES).map((s) => s.port)
  checkGhostProcesses(portsToCheck)

  const skipDocker = opts.skipDocker || opts.noDocker
  const processes = resolveProcessList(services, opts, skipDocker)
  const args = buildPcUpArgs(processes, opts.tui)

  console.log(chalk.bold.blue("\n  IbateXas Dev Environment\n"))
  await printStartPlan(processes, skipDocker)
  preflightCrossRepo(processes)
  printDevFlags()

  // Confirm before launching. Skipped with --yes or when non-interactive
  // (CI / piped stdin) so scripts don't hang waiting on a prompt.
  if (!(await confirmStart(opts))) {
    console.log(chalk.gray("\n  Aborted — nothing started.\n"))
    return
  }

  console.log(chalk.gray(`\n  process-compose ${args.join(" ")}\n`))

  try {
    await execa("process-compose", args, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: "1" },
    })
  } catch {
    // process-compose exits non-zero on Ctrl+C — that's expected
  }
}

// ── process-compose stop ─────────────────────────────────────────────────────

async function pcStop(
  serviceKey: string | undefined,
  opts: { force?: boolean },
): Promise<void> {
  const stopAll = !serviceKey || serviceKey === "all"

  if (opts.force) {
    await forceStop(serviceKey, stopAll)
    return
  }

  // Try graceful stop via process-compose
  const installed = await checkProcessCompose()

  if (installed) {
    try {
      if (stopAll) {
        const spinner = ora({ text: "Stopping all processes…", indent: 2 }).start()
        await execa("process-compose", ["down"], { cwd: ROOT, reject: true })
        spinner.succeed(chalk.green("All service processes stopped"))
      } else {
        const spinner = ora({ text: `Stopping ${serviceKey}…`, indent: 2 }).start()
        await execa("process-compose", ["process", "stop", serviceKey!], { cwd: ROOT, reject: true })
        spinner.succeed(chalk.green(`${serviceKey} stopped`))
      }
    } catch {
      // process-compose not running — fall back to port kill
      console.log(chalk.gray("  process-compose not running — falling back to port kill"))
      await forceStop(serviceKey, stopAll)
    }
  } else {
    await forceStop(serviceKey, stopAll)
  }

  if (stopAll) {
    await stopDockerContainers()
  }

  console.log(chalk.green("\n  Done.\n"))
}

// ── process-compose restart ──────────────────────────────────────────────────

async function pcRestart(target = "all"): Promise<void> {
  console.log(chalk.bold.blue(`\n  Restarting ${target}…\n`))

  const installed = await checkProcessCompose()

  if (installed) {
    try {
      if (target === "all") {
        // Restart all app services (not infra)
        for (const svc of APP_SERVICES) {
          const spinner = ora({ text: `Restarting ${svc}…`, indent: 2 }).start()
          await execa("process-compose", ["process", "restart", svc], { cwd: ROOT, reject: true })
          spinner.succeed(chalk.green(`${svc} restarted`))
        }
      } else {
        const spinner = ora({ text: `Restarting ${target}…`, indent: 2 }).start()
        await execa("process-compose", ["process", "restart", target], { cwd: ROOT, reject: true })
        spinner.succeed(chalk.green(`${target} restarted`))
      }
      return
    } catch {
      console.log(chalk.gray("  process-compose not running — falling back to port kill + restart"))
    }
  }

  // Fallback: kill by port and tell user to start again
  const { SERVICES } = await import("../services.js")
  if (target === "all") {
    for (const svc of Object.values(SERVICES)) forceKillPort(svc.port)
  } else {
    const svc = SERVICES[target]
    if (svc) forceKillPort(svc.port)
  }
  console.log(chalk.yellow("\n  Processes killed. Run ") + chalk.cyan("ibx dev start") + chalk.yellow(" to restart.\n"))
}

// ── Force stop (port-based kill) ─────────────────────────────────────────────

const PROCESS_COMPOSE_PORT = 8080

/** ngrok's local inspector API — the ONLY port an ngrok agent listens on. The
 *  tunnel itself is an OUTBOUND connection to ngrok's edge, and the api (not
 *  ngrok) owns :3001, so a sweep over SERVICES ports can never see the agent. */
const NGROK_INSPECTOR_PORT = 4040

/** Which ports `ibx dev stop -f` sweeps.
 *
 *  Exported (and pure) because the tunnel's absence here was invisible: `-f`
 *  short-circuits `pcStop` BEFORE `process-compose down`, so the `tunnel`
 *  process's own `shutdown: {signal: 15}` never fires, and the sweep that
 *  replaces it never matched ngrok. `-f` then SIGKILLs process-compose on :8080,
 *  so the supervisor dies without reaping anything and ngrok reparents to pid 1
 *  — still holding the account's reserved domain, which makes the NEXT
 *  `ibx dev` fail with ERR_NGROK_334 while `stop -f` had reported "Done."
 *
 *  A named non-tunnel service must NOT take the tunnel down with it: stopping
 *  `web` has nothing to do with WhatsApp webhook delivery. */
export function resolveForceStopPorts(
  serviceKey: string | undefined,
  stopAll: boolean,
  services: Record<string, ServiceDef>,
): number[] {
  if (stopAll) {
    return [
      ...Object.values(services).map((s) => s.port),
      // process-compose's own HTTP server
      PROCESS_COMPOSE_PORT,
      NGROK_INSPECTOR_PORT,
    ]
  }
  // `tunnel` is a process-compose process, not a SERVICES entry — before this it
  // fell through the `SERVICES[serviceKey]` lookup to an empty list, so
  // `ibx dev stop tunnel -f` killed nothing and still printed "Done."
  if (serviceKey === "tunnel") return [NGROK_INSPECTOR_PORT]
  const svc = serviceKey ? services[serviceKey] : undefined
  return svc ? [svc.port] : []
}

async function forceStop(serviceKey: string | undefined, stopAll: boolean): Promise<void> {
  const { SERVICES } = await import("../services.js")

  if (!stopAll && serviceKey && serviceKey !== "tunnel" && !SERVICES[serviceKey]) {
    console.log(chalk.yellow(`\n  Unknown service "${serviceKey}" — nothing to force-kill.\n`))
    return
  }

  const ports = resolveForceStopPorts(serviceKey, stopAll, SERVICES)
  const stopsTunnel = stopAll || serviceKey === "tunnel"
  console.log(chalk.bold.yellow(`\n  Force-killing processes on ports: ${ports.join(", ")}\n`))

  for (const port of ports) {
    forceKillPort(port)
  }

  if (stopsTunnel) {
    killNgrokTunnel(SERVICES.api.port)
  }

  if (stopAll) {
    await stopDockerContainers()
  }

  console.log(chalk.green("\n  Done.\n"))
}

/** Kill the ngrok agent by argv, as a complement to the :4040 sweep.
 *
 *  The port sweep alone is not sufficient: `--inspect=false` leaves the agent
 *  with NO listening port at all, and an already-orphaned agent (pid 1) can
 *  outlive the process-compose run that spawned it by days. Matches the argv
 *  that BOTH spawn paths produce — process-compose.yaml's `tunnel` command and
 *  `ibx tunnel` — including the `--url <domain>` variant, which only appends.
 *
 *  Scoped to the api port on purpose: an ngrok pointed at :3001 IS this stack's
 *  webhook tunnel, whoever started it. Tunnels to other ports are left alone. */
function killNgrokTunnel(apiPort: number): void {
  const pattern = `ngrok http ${apiPort}`
  const { stdout } = execaSync("pgrep", ["-f", pattern], { reject: false })
  const pids = (stdout ?? "").toString().trim().split("\n").filter(Boolean)
  if (pids.length === 0) {
    console.log(chalk.gray("    · ngrok tunnel: clear"))
    return
  }
  execaSync("pkill", ["-9", "-f", pattern], { reject: false })
  console.log(chalk.green(`    ✓ ngrok tunnel: killed ${pids.length} agent(s)`))
}

function forceKillPort(port: number): void {
  const pids = getPortPids(port)
  if (pids.length === 0) {
    console.log(chalk.gray(`    · Port ${port}: clear`))
    return
  }
  // Kill via shell so the signal reaches all processes (including children)
  execaSync("sh", ["-c", `lsof -ti :${port} | xargs kill -9 2>/dev/null`], { reject: false })
  console.log(chalk.green(`    ✓ Port ${port}: killed ${pids.length} process(es)`))
}

// ── Docker stop ──────────────────────────────────────────────────────────────

async function stopDockerContainers(): Promise<void> {
  const dockerSpinner = ora({ text: "Stopping Docker containers…", indent: 2 }).start()
  try {
    await execa("docker", ["compose", "stop"], { cwd: ROOT })
    dockerSpinner.succeed(chalk.green("Docker containers stopped (volumes preserved)"))
  } catch {
    dockerSpinner.fail(chalk.red("Failed to stop Docker containers"))
    process.exit(1)
  }
}

// ── Build/test runner ────────────────────────────────────────────────────────

/**
 * BKL-151 (local half) — fail CLOSED on a dependency skew before building.
 *
 * When the lockfile changed (a merge touched a package.json / a dep bump) but
 * `pnpm install` never ran, `node_modules` is stale. Building against a stale
 * tree surfaces DOWNSTREAM as an opaque ghost (the claims-validate `TypeError`
 * on a shape that a newer dep added) rather than an actionable message. Turn
 * that into a DETERMINISTIC, self-explaining skew error at the build seam.
 *
 * The signal is CONTENT, never mtimes. The original mtime heuristic
 * (`pnpm-lock.yaml` newer than `node_modules`) compared two clocks that measure
 * neither side of the question, and was wrong in both directions — measured
 * 2026-07-26:
 *   · `node_modules`' own mtime only advances when an ENTRY is created/removed
 *     in that one directory. `pnpm install` rewrites `.modules.yaml` / `.pnpm/`
 *     / `.bin/` IN PLACE, so a correct install left the root dir's mtime two
 *     days stale and the guard fired again on the very next build. (The stamp
 *     it was reading had been set by vite creating `.vite-temp` — not by pnpm.)
 *   · Conversely ANY tool dropping a new top-level entry silences the guard
 *     while the tree is genuinely stale.
 *   · And `pnpm install` rewrites `pnpm-lock.yaml` as its last act, re-arming
 *     the guard it was supposed to clear.
 *
 * pnpm keeps the lockfile it ACTUALLY installed at `node_modules/.pnpm/lock.yaml`
 * (the "current" lockfile, kept in sync with the tree). Byte-comparing the two
 * answers the real question exactly, with no clock involved. Fallback for trees
 * without that file: pnpm 10's own validation clock in
 * `node_modules/.pnpm-workspace-state-v1.json`.
 *
 * Returns the reason string when skewed (for testing); `null` when in sync or
 * indeterminate (fresh clone / missing path → let pnpm itself surface it).
 * Exported for unit testing.
 */
export function depsSkewReason(root: string = ROOT): string | null {
  let lockBytes: Buffer
  try {
    lockBytes = fs.readFileSync(path.join(root, "pnpm-lock.yaml"))
  } catch {
    // No lockfile (e.g. a fresh clone) — not a skew we can assert.
    return null
  }

  // Primary: the lockfile pnpm last installed, byte-for-byte.
  try {
    const installed = fs.readFileSync(path.join(root, "node_modules", ".pnpm", "lock.yaml"))
    if (installed.equals(lockBytes)) return null
    return "pnpm-lock.yaml differs from the lockfile pnpm last installed (node_modules/.pnpm/lock.yaml) — dependencies changed but were not installed"
  } catch {
    // No installed-lock (never installed, or a pnpm that does not write it) —
    // fall through to pnpm's own validation clock.
  }

  // Fallback: pnpm 10 stamps when it last validated node_modules against the
  // lockfile. Unlike a directory mtime this IS advanced by every install.
  try {
    const statePath = path.join(root, "node_modules", ".pnpm-workspace-state-v1.json")
    const validatedAt = JSON.parse(fs.readFileSync(statePath, "utf8")).lastValidatedTimestamp
    if (typeof validatedAt !== "number") return null
    const lockMtime = fs.statSync(path.join(root, "pnpm-lock.yaml")).mtimeMs
    if (lockMtime > validatedAt) {
      return "pnpm-lock.yaml changed after pnpm last validated node_modules — dependencies changed but were not installed"
    }
    return null
  } catch {
    // No node_modules at all / unreadable state — indeterminate; let the build
    // or pnpm surface the real problem.
    return null
  }
}

/** Print the skew error and exit(1) fail-closed when deps are out of sync. */
function assertDepsInstalled(): void {
  const reason = depsSkewReason()
  if (reason !== null) {
    console.error(chalk.red(`\n  ${reason}.`))
    console.error(chalk.yellow("  Run: pnpm install   (then retry)\n"))
    process.exit(1)
  }
}

async function runPnpmCommand(rawFilter: string | undefined, command: "build" | "test"): Promise<void> {
  // BKL-151 — before building packages, fail closed on a lockfile↔node_modules
  // skew so a stale build never surfaces later as the claims-validate ghost.
  if (command === "build") assertDepsInstalled()
  const filter = rawFilter ? resolveFilter(rawFilter) : undefined
  const args = filter
    ? ["--filter", filter, command]
    : ["turbo", command]
  const label = filter ? `pnpm --filter ${filter} ${command}` : `pnpm turbo ${command}`

  const action = command === "build" ? "Building" : "Running tests"
  console.log(chalk.bold(`\n  ${chalk.cyan("→")} ${action}…\n`))
  console.log(chalk.gray(`    ${label}\n`))

  try {
    await execa("pnpm", args, { cwd: ROOT, stdio: "inherit" })
    const success = command === "build" ? "Build complete" : "Tests passed"
    console.log(chalk.green(`\n  ${success}\n`))
  } catch {
    const failure = command === "build" ? "Build failed" : "Tests failed"
    console.error(chalk.red(`\n  ${failure}\n`))
    process.exit(1)
  }
}

// ── Behavior flags ────────────────────────────────────────────────────────────

/** Compact one-glance summary of the env flags that change how the stack behaves
 *  (auth bypass, embeddings, audit, destructive jobs). Warns on risky states so a
 *  developer notices e.g. "embeddings are fake" before debugging search. */
function printDevFlags(): void {
  const KW = 26
  console.log(chalk.bold("  Behavior flags") + chalk.gray("   (ibx env flags · ibx env toggle <KEY>)"))
  for (const f of DEV_FLAGS) {
    const eff = process.env[f.key]
    const isSet = eff !== undefined && eff.trim() !== ""
    const warn = f.alert?.(eff)

    let shown: string
    if (!isSet) shown = chalk.gray(`(unset → ${f.fallback})`)
    else if (f.kind === "secret") shown = chalk.green("set")
    else shown = chalk.white(eff)

    const marker = warn ? chalk.yellow("!") : chalk.green("✓")
    const tail = warn ? "  " + chalk.yellow("⚠ " + warn) : ""
    console.log(`  ${marker} ${chalk.cyan(f.key.padEnd(KW))} ${shown}${tail}`)
  }
  console.log()
}

// ── Start plan ────────────────────────────────────────────────────────────────

/** Compact table of what `ibx dev` is about to launch — infra + app URLs +
 *  optional services — so the developer can eyeball the target before confirming.
 *  Full URL list lives in `ibx dev urls`. */
async function printStartPlan(processes: string[], skipDocker: boolean | undefined): Promise<void> {
  const { resolveServices, infraEndpoints, observabilityEndpoints } = await import("../services.js")
  const all = processes.length === 0 // empty filter = start everything in the YAML
  const has = (name: string) => all || processes.includes(name)

  console.log(chalk.bold("  Starting") + chalk.gray("   (full URLs: ibx dev urls)"))

  const NAME_W = 18
  const row = (name: string, detail: string) =>
    console.log(`  ${chalk.green("▸")} ${name.padEnd(NAME_W)} ${chalk.cyan(detail)}`)

  if (has("infra") && !skipDocker) {
    row("Infra", infraEndpoints().map((e) => `${e.name} ${e.address}`).join("  ·  "))
  }
  if (has("observability") && !skipDocker) {
    row("Observability", observabilityEndpoints().map((e) => `${e.name} ${e.address}`).join("  ·  "))
  } else {
    // BKL-266 — say the consequence out loud at the same place the developer
    // chose it. VictoriaLogs is the ONLY record of a zero-call funnel turn.
    console.log(
      `  ${chalk.yellow("!")} ${"Observability".padEnd(NAME_W)} ` +
        chalk.yellow("OFF — zero-call funnel turns (L0/L1/L2-fallback/ALIAS) will not be recorded anywhere"),
    )
  }
  const services = resolveServices(undefined)
  for (const svc of services) {
    if ((svc.group ?? "app") === "app" && has(svc.key)) row(svc.name, svc.urls[0]?.url ?? `:${svc.port}`)
  }
  for (const svc of services) {
    if (svc.group === "ops" && has(svc.key)) row(svc.name, svc.urls[0]?.url ?? `:${svc.port}`)
  }
  if (has("tunnel")) row("ngrok Tunnel", "→ :3001 (WhatsApp webhooks)")
  if (has("stripe")) row("Stripe", "→ :3001/api/webhooks/stripe")

  console.log()
}

// ── URL summary ──────────────────────────────────────────────────────────────

/** Print one service's URL links + notes into the dev-URL summary. */
function printServiceLinks(
  svc: ServiceDef,
  url: (label: string, value: string) => void,
): void {
  for (const link of svc.urls) url(link.label.trim(), link.url)
  for (const note of svc.notes ?? []) console.log(chalk.gray(`  ${note}`))
}

/** Print a one-glance summary of every dev URL: apps, infra, observability,
 *  optional services, and the log-viewing CLI commands. */
async function printDevUrls(): Promise<void> {
  const { resolveServices, infraEndpoints, observabilityEndpoints } = await import("../services.js")
  const { fetchNgrokUrl } = await import("./tunnel.js")
  const { VICTORIALOGS_URL } = await import("../lib/logs-query.js")

  const LABEL_W = 16
  const section = (title: string) => console.log(chalk.dim(`\n  ─ ${title} ─`))
  const url = (label: string, value: string) =>
    console.log(`  ${label.padEnd(LABEL_W)}${chalk.cyan(value)}`)
  const hint = (label: string, value: string) =>
    console.log(`  ${label.padEnd(LABEL_W)}${chalk.gray(value)}`)

  console.log(chalk.bold("\n  IbateXas — Dev URLs"))

  const services = resolveServices(undefined)

  // ── Apps (product surfaces) ──
  section("Apps")
  for (const svc of services) {
    if ((svc.group ?? "app") === "app") printServiceLinks(svc, url)
  }

  // ── Ops (operator + QA surfaces) ──
  section("Ops")
  for (const svc of services) {
    if (svc.group === "ops") printServiceLinks(svc, url)
  }

  // ── Infra ──
  section("Infra")
  for (const ep of infraEndpoints()) url(ep.name, ep.address)
  url("NATS Monitor", "http://localhost:8222")

  // ── Observability (live obs stack — Grafana/VictoriaLogs/VictoriaMetrics) ──
  section("Observability")
  for (const ep of observabilityEndpoints()) url(ep.name, ep.address)
  // VICTORIALOGS_URL is the configured logs endpoint the api ships to; surface
  // its vmui explicitly in case it diverges from the default obs address.
  url("Logs (vmui)", `${VICTORIALOGS_URL}/select/vmui/`)

  // ── Optional ──
  section("Optional")
  const ngrokUrl = await fetchNgrokUrl(1)
  if (ngrokUrl) url("ngrok Tunnel", `${ngrokUrl}  (→ :3001)`)
  else hint("ngrok Tunnel", "not running — start with: ibx dev start --with-tunnel")
  hint("Stripe", "forwarding → localhost:3001/api/webhooks/stripe  (with --with-stripe)")

  // ── Logs (CLI) ──
  section("Logs (CLI)")
  hint("Infra logs", "ibx svc logs [postgres|redis|typesense|nats]")
  hint("Health", "ibx svc status")

  console.log()
}

// ── Command registration ────────────────────────────────────────────────────

export function registerDevCommands(dev: Command) {

  // FE-D05 — with the root program (index.ts), enable positional options on
  // `dev` too so `ibx dev start [services] --no-tui -y` routes both flags to
  // the `start` subcommand rather than the parent `dev` default action (which
  // declares the same options and otherwise shadows them → silent flag drop).
  dev.enablePositionalOptions()

  // ── ibx dev [services...]  (default action) ──────────────────────────────
  dev
    .description("SDLC — development lifecycle")
    .argument("[services...]", "commerce api web admin all (default: 4 core services)")
    .option("--skip-docker, --no-docker", "Skip 'docker compose up' (assume infra is already running)")
    .option("--no-tui", "Disable TUI (plain log output)")
    .option("--no-observability", "Skip the VictoriaLogs/VictoriaMetrics/Grafana stack (loses zero-call funnel records)")
    .option("--with-tunnel", "Enable ngrok tunnel")
    .option("--with-stripe", "Enable Stripe webhook forwarding")
    .option("-y, --yes", "Skip the start confirmation prompt")
    .action(async (services: string[], opts: StartOpts) => {
      await pcStart(services, opts)
    })

  // ── ibx dev start [services...] ─────────────────────────────────────────
  dev
    .command("start [services...]")
    .description("Start dev stack in TUI — 4 core services by default, 'all' includes tunnel + stripe")
    .option("--skip-docker, --no-docker", "Skip 'docker compose up' (assume infra is already running)")
    .option("--no-tui", "Disable TUI (plain log output)")
    .option("--no-observability", "Skip the VictoriaLogs/VictoriaMetrics/Grafana stack (loses zero-call funnel records)")
    .option("--with-tunnel", "Enable ngrok tunnel")
    .option("--with-stripe", "Enable Stripe webhook forwarding")
    .option("-y, --yes", "Skip the start confirmation prompt")
    .action(async (services: string[], opts: StartOpts) => {
      await pcStart(services, opts)
    })

  // ── ibx dev urls ────────────────────────────────────────────────────────
  dev
    .command("urls")
    .description("Print a summary of all dev URLs (apps, infra, observability, optional)")
    .action(printDevUrls)

  // ── ibx dev stop [service] ──────────────────────────────────────────────
  dev
    .command("stop [service]")
    .description("Stop service(s) — omit to stop all + Docker (-f to force-kill ports). `tunnel` stops ngrok.")
    .option("-f, --force", "Force-kill by port (services + :8080 + ngrok :4040); skips graceful shutdown")
    .action(async (serviceKey: string | undefined, opts: { force?: boolean }) => {
      await pcStop(serviceKey, opts)
    })

  // ── ibx dev restart [service] ───────────────────────────────────────────
  dev
    .command("restart [service]")
    .description("Restart service(s) in-place via process-compose")
    .action(async (serviceKey: string | undefined) => {
      await pcRestart(serviceKey)
    })

  // ── ibx dev build [filter] ──────────────────────────────────────────────
  dev
    .command("build [filter]")
    .description("Build packages (runs turbo build)")
    .action((rawFilter: string | undefined) => runPnpmCommand(rawFilter, "build"))

  // ── ibx dev test [filter] ───────────────────────────────────────────────
  dev
    .command("test [filter]")
    .description("Run tests (runs vitest via turbo)")
    .action((rawFilter: string | undefined) => runPnpmCommand(rawFilter, "test"))
}
