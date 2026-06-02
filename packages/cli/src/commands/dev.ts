import fs from "node:fs"
import path from "node:path"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { execa, execaSync } from "execa"
import { ROOT } from "../utils/root.js"

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
const APP_SERVICES = ["commerce", "api", "web", "admin"] as const

// ── process-compose detection ────────────────────────────────────────────────

async function checkProcessCompose(): Promise<boolean> {
  try {
    await execa("process-compose", ["version"], { reject: true })
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

// ── process-compose start ────────────────────────────────────────────────────

interface StartOpts {
  skipDocker?: boolean
  noDocker?: boolean
  tui: boolean
  withTunnel?: boolean
  withStripe?: boolean
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

  // Build process-compose args
  const args = ["up", "-f", PC_YAML]

  if (!opts.tui) args.push("-t=false")

  const isAll = services.includes("all")
  const skipDocker = opts.skipDocker || opts.noDocker
  const named = services.filter((s) => s !== "all")

  // Build process list:
  //   named args → only those (process-compose resolves deps)
  //   "all"      → no filter (starts everything including tunnel/stripe)
  //   default    → core only, optionally + tunnel/stripe via flags
  const CORE = ["infra", "build-packages", "commerce", "api", "web-clean", "web", "admin-clean", "admin"]
  let processes: string[] = []

  if (named.length > 0) {
    processes = named
  } else if (isAll) {
    processes = [] // empty = start all processes in YAML
  } else {
    processes = [...CORE]
    if (opts.withTunnel) processes.push("tunnel")
    if (opts.withStripe) processes.push("stripe")
  }

  if (skipDocker) {
    const idx = processes.indexOf("infra")
    if (idx !== -1) processes.splice(idx, 1)
  }

  args.push(...processes)

  console.log(chalk.bold.blue("\n  IbateXas Dev Environment\n"))
  console.log(chalk.gray(`  process-compose ${args.join(" ")}\n`))

  // Layer 6 — surface where to watch the system once it's up. Shown whenever the
  // bring-up includes infra (default / "all"), i.e. when VictoriaLogs is started.
  if (!skipDocker && (processes.length === 0 || processes.includes("infra"))) {
    const vlUrl = process.env.VICTORIALOGS_URL ?? "http://localhost:9428"
    const level = process.env.LOG_LEVEL ?? "info"
    console.log(chalk.bold("  Observability"))
    console.log(`    ${chalk.cyan("Logs UI")}  ${vlUrl}  ${chalk.gray("(VictoriaLogs — LogsQL + web UI)")}`)
    console.log(`    ${chalk.cyan("Watch  ")}  ${chalk.gray("ibx logs --follow  ·  ibx obs decisions -f  ·  ibx status")}`)
    console.log(`    ${chalk.cyan("Level  ")}  LOG_LEVEL=${level}  ${chalk.gray("(set LOG_LEVEL=debug for verbose)")}\n`)
  }

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

async function pcRestart(serviceKey: string | undefined): Promise<void> {
  const target = serviceKey ?? "all"
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

async function forceStop(serviceKey: string | undefined, stopAll: boolean): Promise<void> {
  const { SERVICES } = await import("../services.js")
  let targets: (typeof SERVICES)[string][]
  if (stopAll) targets = Object.values(SERVICES)
  else if (serviceKey) targets = [SERVICES[serviceKey]].filter(Boolean)
  else targets = []

  const ports = targets.map((s) => s.port)
  // Also kill process-compose's own HTTP server on stop-all
  if (stopAll) ports.push(PROCESS_COMPOSE_PORT)
  console.log(chalk.bold.yellow(`\n  Force-killing processes on ports: ${ports.join(", ")}\n`))

  for (const port of ports) {
    forceKillPort(port)
  }

  if (stopAll) {
    await stopDockerContainers()
  }

  console.log(chalk.green("\n  Done.\n"))
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

type DevTask = "build" | "test" | "lint" | "typecheck"

const TASK_LABELS: Record<DevTask, { active: string; ok: string; fail: string }> = {
  build:     { active: "Building",      ok: "Build complete", fail: "Build failed" },
  test:      { active: "Running tests", ok: "Tests passed",   fail: "Tests failed" },
  lint:      { active: "Linting",       ok: "Lint clean",     fail: "Lint failed" },
  typecheck: { active: "Typechecking",  ok: "Types clean",    fail: "Typecheck failed" },
}

async function runPnpmCommand(rawFilter: string | undefined, command: DevTask): Promise<void> {
  const filter = rawFilter ? resolveFilter(rawFilter) : undefined
  const args = filter
    ? ["--filter", filter, command]
    : ["turbo", command]
  const label = filter ? `pnpm --filter ${filter} ${command}` : `pnpm turbo ${command}`
  const labels = TASK_LABELS[command]

  console.log(chalk.bold(`\n  ${chalk.cyan("→")} ${labels.active}…\n`))
  console.log(chalk.gray(`    ${label}\n`))

  try {
    await execa("pnpm", args, { cwd: ROOT, stdio: "inherit" })
    console.log(chalk.green(`\n  ${labels.ok}\n`))
  } catch {
    console.error(chalk.red(`\n  ${labels.fail}\n`))
    process.exit(1)
  }
}

// ── Full cross-workspace gate ────────────────────────────────────────────────
// The green-at-commit gate across the whole pnpm workspace (ibatexas + the
// linked claustrum + adjudicate packages): build → typecheck → lint → test in
// one turbo run. --concurrency=3 is mandatory on this machine (the CPU-bound
// property/async suites time out and produce spurious red at higher concurrency).
async function runGate(opts: { force?: boolean }): Promise<void> {
  const args = ["turbo", "build", "typecheck", "lint", "test", "--concurrency=3"]
  if (opts.force) args.push("--force")
  console.log(chalk.bold(`\n  ${chalk.cyan("→")} Gate — build · typecheck · lint · test (concurrency 3)…\n`))
  console.log(chalk.gray(`    pnpm ${args.join(" ")}\n`))
  try {
    await execa("pnpm", args, { cwd: ROOT, stdio: "inherit" })
    console.log(chalk.green(`\n  ✅  Gate green\n`))
  } catch {
    console.error(chalk.red(`\n  ❌  Gate failed\n`))
    process.exit(1)
  }
}

// ── Command registration ────────────────────────────────────────────────────

export function registerDevCommands(dev: Command) {

  // ── ibx dev [services...]  (default action) ──────────────────────────────
  dev
    .description("SDLC — development lifecycle")
    .argument("[services...]", "commerce api web admin all (default: 4 core services)")
    .option("--skip-docker, --no-docker", "Skip 'docker compose up' (assume infra is already running)")
    .option("--no-tui", "Disable TUI (plain log output)")
    .option("--with-tunnel", "Enable ngrok tunnel")
    .option("--with-stripe", "Enable Stripe webhook forwarding")
    .action(async (services: string[], opts: StartOpts) => {
      await pcStart(services, opts)
    })

  // ── ibx dev start [services...] ─────────────────────────────────────────
  dev
    .command("start [services...]")
    .description("Start dev stack in TUI — 4 core services by default, 'all' includes tunnel + stripe")
    .option("--skip-docker, --no-docker", "Skip 'docker compose up' (assume infra is already running)")
    .option("--no-tui", "Disable TUI (plain log output)")
    .option("--with-tunnel", "Enable ngrok tunnel")
    .option("--with-stripe", "Enable Stripe webhook forwarding")
    .action(async (services: string[], opts: StartOpts) => {
      await pcStart(services, opts)
    })

  // ── ibx dev stop [service] ──────────────────────────────────────────────
  dev
    .command("stop [service]")
    .description("Stop service(s) — omit to stop all + Docker (-f to force-kill ports)")
    .option("-f, --force", "Force-kill any process listening on service ports")
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

  // ── ibx dev lint [filter] ───────────────────────────────────────────────
  dev
    .command("lint [filter]")
    .description("Lint packages (runs turbo lint)")
    .action((rawFilter: string | undefined) => runPnpmCommand(rawFilter, "lint"))

  // ── ibx dev typecheck [filter] ──────────────────────────────────────────
  dev
    .command("typecheck [filter]")
    .description("Typecheck packages (runs turbo typecheck)")
    .action((rawFilter: string | undefined) => runPnpmCommand(rawFilter, "typecheck"))

  // ── ibx dev gate ────────────────────────────────────────────────────────
  dev
    .command("gate")
    .description("Full cross-workspace gate: build + typecheck + lint + test (--force busts cache)")
    .option("--force", "Bust the turbo cache (0 cached — the honest green-at-commit bar)")
    .action((opts: { force?: boolean }) => runGate(opts))
}
