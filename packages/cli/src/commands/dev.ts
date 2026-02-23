import type { Command } from "commander"
import type { ExecaChildProcess } from "execa"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import net from "node:net"
import { ROOT } from "../utils/root.js"
import { resolveServices, type ServiceDef } from "../services.js"

// ── Types ─────────────────────────────────────────────────────────────────────

interface InfraEntry {
  label: string
  address: string
  extra?: string
  ok: boolean
  ms: number
}

// ── Network helpers ───────────────────────────────────────────────────────────

async function tcpOk(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => { s.destroy(); resolve(true) })
    s.once("error", () => resolve(false))
    s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false) })
  })
}

async function httpOk(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

// ── Infrastructure health (runs before starting any app) ──────────────────────

async function checkInfrastructure(): Promise<InfraEntry[]> {
  const dbUrl = process.env.DATABASE_URL ?? ""
  const dbHost = dbUrl ? new URL(dbUrl).hostname : "localhost"
  const dbPort = dbUrl ? Number(new URL(dbUrl).port || 5433) : 5433

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
  const redisHost = new URL(redisUrl).hostname
  const redisPort = Number(new URL(redisUrl).port || 6379)

  const typesenseHost = process.env.TYPESENSE_HOST ?? "localhost"
  const typesensePort = Number(process.env.TYPESENSE_PORT ?? 8108)

  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222"
  const natsHost = new URL(natsUrl).hostname
  const natsPort = Number(new URL(natsUrl).port || 4222)

  const checks: { entry: Omit<InfraEntry, "ok" | "ms">; check: () => Promise<boolean> }[] = [
    {
      entry: { label: "PostgreSQL", address: `${dbHost}:${dbPort}` },
      check: () => tcpOk(dbHost, dbPort),
    },
    {
      entry: { label: "Redis", address: `${redisHost}:${redisPort}` },
      check: () => tcpOk(redisHost, redisPort),
    },
    {
      entry: {
        label: "Typesense",
        address: `http://${typesenseHost}:${typesensePort}`,
      },
      check: () => httpOk(`http://${typesenseHost}:${typesensePort}/health`),
    },
    {
      entry: {
        label: "NATS",
        address: `${natsHost}:${natsPort}`,
        extra: `monitor: http://${natsHost}:8222`,
      },
      check: () => tcpOk(natsHost, natsPort),
    },
  ]

  const results = await Promise.all(
    checks.map(async ({ entry, check }) => {
      const start = Date.now()
      const ok = await check()
      return { ...entry, ok, ms: Date.now() - start } satisfies InfraEntry
    })
  )

  for (const r of results) {
    const icon = r.ok ? chalk.green("✓") : chalk.red("✗")
    const ms = chalk.gray(`${r.ms}ms`)
    const name = r.ok ? chalk.white(r.label.padEnd(14)) : chalk.red(r.label.padEnd(14))
    console.log(`    ${icon}  ${name}  ${ms}`)
  }

  if (results.some((r) => !r.ok)) {
    console.log(chalk.red("\n  Infrastructure check failed. Is Docker running?\n"))
    process.exit(1)
  }

  return results
}

// ── Service process management ────────────────────────────────────────────────

function spawnService(svc: ServiceDef): ExecaChildProcess {
  const proc = execa(
    "pnpm",
    ["--filter", svc.filter, svc.script],
    { cwd: ROOT, env: { ...process.env }, reject: false }
  )

  const prefix = svc.logColor(`[${svc.logPrefix}]`)

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trimEnd().split("\n")) {
      process.stdout.write(`${prefix} ${chalk.dim(line)}\n`)
    }
  })

  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trimEnd().split("\n")) {
      process.stderr.write(`${prefix} ${chalk.dim(line)}\n`)
    }
  })

  return proc
}

async function waitForService(
  svc: ServiceDef,
  timeoutMs = 120_000,
  intervalMs = 2_000
): Promise<boolean> {
  if (!svc.healthUrl) return true

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(svc.healthUrl, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        if (!svc.healthExpect) return true
        const text = await res.text()
        if (text.trim() === svc.healthExpect) return true
      }
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

// ── Summary box ───────────────────────────────────────────────────────────────

function printSummary(services: ServiceDef[], infra: InfraEntry[]): void {
  const width = 62
  const border = "─".repeat(width)

  const line = (content: string) => {
    const visible = content.replace(/\x1b\[[0-9;]*m/g, "")
    const pad = Math.max(0, width - visible.length)
    console.log(`  │${content}${" ".repeat(pad)}│`)
  }

  const sectionHeader = (title: string) => {
    const dashes = "─".repeat(Math.max(0, width - title.length - 2))
    console.log(chalk.bold(`  ├─ ${title} ${dashes}┤`))
  }

  console.log()
  console.log(chalk.bold(`  ┌${border}┐`))
  line("")
  line(chalk.bold("  IbateXas — Dev Environment Ready"))
  line("")

  // ── Infrastructure section ─────────────────────────────────────────────────
  sectionHeader("Infrastructure")
  line("")
  for (const r of infra) {
    const icon = chalk.green("  ✓  ")
    const label = r.label.padEnd(12)
    const addr = chalk.cyan(r.address)
    const extra = r.extra ? chalk.dim(`  ·  ${r.extra}`) : ""
    line(`${icon}${label}  ${addr}${extra}`)
  }
  line("")

  // ── Services section ───────────────────────────────────────────────────────
  sectionHeader("Services")
  line("")
  for (const svc of services) {
    for (const u of svc.urls) {
      const icon = chalk.green("  ✓  ")
      const label = u.label.padEnd(12)
      line(`${icon}${label}  ${chalk.cyan(u.url)}`)
    }
    for (const note of svc.notes ?? []) {
      line(chalk.gray(`        ${note}`))
    }
  }
  line("")

  // ── Footer ─────────────────────────────────────────────────────────────────
  console.log(chalk.bold(`  ├${border}┤`))
  line(chalk.dim("  Press Ctrl+C to stop all services"))
  console.log(chalk.bold(`  └${border}┘`))
  console.log()
}

// ── Step header ───────────────────────────────────────────────────────────────

const step = (n: number, total: number, msg: string) =>
  console.log(chalk.bold(`\n${chalk.cyan(`[${n}/${total}]`)} ${msg}`))

// ── Command registration ──────────────────────────────────────────────────────

export function registerDevCommands(dev: Command) {

  // ── ibx dev [service] ────────────────────────────────────────────────────
  dev
    .description("SDLC — development lifecycle")
    .argument("[service]", "commerce (default) | all")
    .option("--skip-docker", "Skip 'docker compose up' (assume infra is already running)")
    .option("--no-wait", "Start services without polling health endpoints")
    .action(async (serviceArg: string | undefined, opts: { skipDocker?: boolean; wait: boolean }) => {

      let services: ServiceDef[]
      try {
        services = resolveServices(serviceArg)
      } catch (err) {
        console.error(chalk.red(`\n  ${String(err)}\n`))
        process.exit(1)
      }

      const TOTAL = opts.wait ? 4 : 3
      console.log(chalk.bold.blue("\n  🔥  IbateXas Dev Environment\n"))

      // ── [1/N] Docker ──────────────────────────────────────────────────────
      step(1, TOTAL, "Starting infrastructure…")

      if (opts.skipDocker) {
        console.log(chalk.gray("    --skip-docker: assuming containers are already up"))
      } else {
        const spinner = ora({ text: "docker compose up -d --wait", indent: 4 }).start()
        try {
          await execa("docker", ["compose", "up", "-d", "--wait"], { cwd: ROOT })
          spinner.succeed(chalk.green("Docker services healthy"))
        } catch (err) {
          spinner.fail(chalk.red("Docker failed to start"))
          console.error(chalk.gray(String(err)))
          process.exit(1)
        }
      }

      // ── [2/N] Infrastructure health ───────────────────────────────────────
      step(2, TOTAL, "Verifying infrastructure…")
      const infraEntries = await checkInfrastructure()

      // ── [3/N] Spawn services ──────────────────────────────────────────────
      const serviceNames = services.map((s) => s.name).join(", ")
      step(3, TOTAL, `Starting ${serviceNames}…`)

      if (services.length > 1) {
        const coloredPrefixes = services.map((s) => s.logColor(`[${s.logPrefix}]`)).join("  ")
        console.log(chalk.gray(`    Log prefixes: ${coloredPrefixes}\n`))
      } else {
        console.log(chalk.gray(`    Logs prefixed with ${services[0].logColor(`[${services[0].logPrefix}]`)}\n`))
      }

      const procs = services.map((svc) => spawnService(svc))

      process.on("SIGINT", () => {
        console.log(chalk.yellow("\n\n  Shutting down…"))
        for (const p of procs) p.kill("SIGTERM")
        process.exit(0)
      })

      // ── [4/N] Wait for all services ───────────────────────────────────────
      if (opts.wait) {
        step(4, TOTAL, "Waiting for services to be ready…")

        const readyResults = await Promise.all(
          services.map(async (svc, i) => {
            if (!svc.healthUrl) return { svc, ready: true }
            const spinner = ora({
              text: `${svc.name} — polling ${svc.healthUrl}`,
              indent: 4,
            }).start()
            const startTs = Date.now()
            const ready = await waitForService(svc, 120_000, 2_000)
            const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)
            if (ready) {
              spinner.succeed(chalk.green(`${svc.name} ready  ${chalk.gray(`(${elapsed}s)`)}`))
            } else {
              spinner.fail(chalk.red(`${svc.name} did not become ready within 120s`))
              procs[i].kill("SIGTERM")
            }
            return { svc, ready }
          })
        )

        if (readyResults.some((r) => !r.ready)) {
          const failed = readyResults.filter((r) => !r.ready).map((r) => r.svc.name)
          console.log(chalk.red(`\n  Failed to start: ${failed.join(", ")}\n`))
          process.exit(1)
        }
      }

      printSummary(services, infraEntries)

      await Promise.all(procs)
    })

  // ── ibx dev stop ─────────────────────────────────────────────────────────
  dev
    .command("stop")
    .description("Stop all Docker containers")
    .action(async () => {
      const spinner = ora({ text: "Stopping Docker containers…", indent: 2 }).start()
      try {
        await execa("docker", ["compose", "down"], { cwd: ROOT })
        spinner.succeed(chalk.green("Docker containers stopped"))
      } catch {
        spinner.fail(chalk.red("Failed to stop Docker containers"))
        process.exit(1)
      }
    })

  // ── ibx dev build [filter] ────────────────────────────────────────────────
  dev
    .command("build [filter]")
    .description("Build packages (runs turbo build)")
    .action(async (filter: string | undefined) => {
      const args = filter
        ? ["--filter", filter, "build"]
        : ["turbo", "build"]
      const cmd = filter ? "pnpm" : "pnpm"
      const label = filter ? `pnpm --filter ${filter} build` : "pnpm turbo build"

      console.log(chalk.bold(`\n  ${chalk.cyan("→")} Building…\n`))
      console.log(chalk.gray(`    ${label}\n`))

      try {
        await execa(cmd, args, { cwd: ROOT, stdio: "inherit" })
        console.log(chalk.green("\n  Build complete\n"))
      } catch {
        console.error(chalk.red("\n  Build failed\n"))
        process.exit(1)
      }
    })

  // ── ibx dev test [filter] ─────────────────────────────────────────────────
  dev
    .command("test [filter]")
    .description("Run tests (runs vitest via turbo)")
    .action(async (filter: string | undefined) => {
      const args = filter
        ? ["--filter", filter, "test"]
        : ["turbo", "test"]
      const label = filter ? `pnpm --filter ${filter} test` : "pnpm turbo test"

      console.log(chalk.bold(`\n  ${chalk.cyan("→")} Running tests…\n`))
      console.log(chalk.gray(`    ${label}\n`))

      try {
        await execa("pnpm", args, { cwd: ROOT, stdio: "inherit" })
        console.log(chalk.green("\n  Tests passed\n"))
      } catch {
        console.error(chalk.red("\n  Tests failed\n"))
        process.exit(1)
      }
    })
}
