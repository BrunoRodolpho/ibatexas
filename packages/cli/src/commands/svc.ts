import type { Command } from "commander"
import chalk from "chalk"
import net from "node:net"
import { SERVICES } from "../services.js"
import { ROOT } from "../utils/root.js"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceHealth {
  service: string
  status: "ok" | "error"
  latencyMs: number
  error?: string
}

// ── Basic health check functions (summary view) ───────────────────────────────

export async function checkPostgres(databaseUrl: string): Promise<ServiceHealth> {
  const start = Date.now()
  try {
    const { default: pg } = await import("pg" as string).catch(() => {
      throw new Error("pg module not available")
    })
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    await client.query("SELECT 1")
    await client.end()
    return { service: "PostgreSQL", status: "ok", latencyMs: Date.now() - start }
  } catch (err) {
    return { service: "PostgreSQL", status: "error", latencyMs: Date.now() - start, error: String(err) }
  }
}

export async function checkRedis(redisUrl: string): Promise<ServiceHealth> {
  const start = Date.now()
  return new Promise((resolve) => {
    const url = new URL(redisUrl)
    const socket = net.createConnection(
      { host: url.hostname, port: Number(url.port || 6379) },
      () => { socket.write("PING\r\n") }
    )
    socket.once("data", () => {
      socket.destroy()
      resolve({ service: "Redis", status: "ok", latencyMs: Date.now() - start })
    })
    socket.once("error", (err) =>
      resolve({ service: "Redis", status: "error", latencyMs: Date.now() - start, error: err.message })
    )
    socket.setTimeout(3000, () => {
      socket.destroy()
      resolve({ service: "Redis", status: "error", latencyMs: Date.now() - start, error: "timeout" })
    })
  })
}

export async function checkTypesense(host: string, port: string): Promise<ServiceHealth> {
  const start = Date.now()
  // Use environment variable or default to 10s (accounts for slow startup on first run)
  const timeoutMs = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 10000)
  const maxAttempts = 3
  let lastError: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) {
        return { service: "Typesense", status: "ok", latencyMs: Date.now() - start }
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = `${err instanceof Error ? err.message : String(err)}`
    }

    // Only log retry if we have more attempts
    if (attempt < maxAttempts) {
      const sleepMs = 200 * attempt
      console.log(`    ↻ Typesense failed: ${lastError} (retry in ${sleepMs}ms)`)
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }

  return { service: "Typesense", status: "error", latencyMs: Date.now() - start, error: lastError || "unknown error" }
}

export async function checkNats(natsUrl: string): Promise<ServiceHealth> {
  const start = Date.now()
  return new Promise((resolve) => {
    const url = new URL(natsUrl)
    const socket = net.createConnection(
      { host: url.hostname, port: Number(url.port || 4222) },
      () => { socket.destroy(); resolve({ service: "NATS", status: "ok", latencyMs: Date.now() - start }) }
    )
    socket.once("error", (err) =>
      resolve({ service: "NATS", status: "error", latencyMs: Date.now() - start, error: err.message })
    )
    socket.setTimeout(3000, () => {
      socket.destroy()
      resolve({ service: "NATS", status: "error", latencyMs: Date.now() - start, error: "timeout" })
    })
  })
}

// ── Detailed health check functions ───────────────────────────────────────────

async function latencySamples(
  check: () => Promise<ServiceHealth>,
  n = 3
): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const r = await check()
    samples.push(r.latencyMs)
  }
  return samples
}

function renderLatencySamples(samples: number[]): void {
  const checks = samples.map((ms) => `${chalk.green("✓")}  ${ms}ms`).join("   ")
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  console.log(`\n  ${chalk.bold("Latency")}  (${samples.length} samples)`)
  console.log(`    ${checks}`)
  console.log(`    avg ${avg}ms  ·  min ${min}ms  ·  max ${max}ms`)
}

async function detailPostgres(databaseUrl: string): Promise<void> {
  console.log(chalk.bold(`\n  ${chalk.cyan("●")} PostgreSQL — Detailed Health\n`))

  const start = Date.now()
  try {
    const { default: pg } = await import("pg" as string).catch(() => {
      throw new Error("pg module not available")
    })
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()

    const [versionRes, connRes, maxRes] = await Promise.all([
      client.query("SELECT version()"),
      client.query("SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL"),
      client.query("SHOW max_connections"),
    ])
    await client.end()

    const latencyMs = Date.now() - start
    const version: string = versionRes.rows[0].version
    const activeConns: number = Number.parseInt(connRes.rows[0].count, 10)
    const maxConns: number = Number.parseInt(maxRes.rows[0].max_connections, 10)

    const url = new URL(databaseUrl)
    const dbName = url.pathname.slice(1)
    const host = `${url.hostname}:${url.port || 5433}`

    console.log(`  ${chalk.bold("Status")}       ${chalk.green("✓  ok")}`)
    console.log(`  ${chalk.bold("Connection")}   ${chalk.cyan(host)}  /  ${chalk.white(dbName)}`)
    console.log(`\n  ${chalk.bold("Server")}       ${chalk.gray(version.split(" on ")[0] ?? version)}`)
    console.log(`  ${chalk.bold("Connections")}  ${chalk.white(String(activeConns))} active  /  ${chalk.white(String(maxConns))} max`)

    const samples = await latencySamples(() => checkPostgres(databaseUrl))
    renderLatencySamples(samples)
    console.log()

    console.log(chalk.gray(`  Latency includes TCP + query roundtrip.  Initial check: ${latencyMs}ms\n`))
  } catch (err) {
    console.log(`  ${chalk.bold("Status")}  ${chalk.red("✗  error")}`)
    console.log(chalk.red(`\n  ${String(err)}\n`))
    process.exit(1)
  }
}

async function detailRedis(redisUrl: string): Promise<void> {
  console.log(chalk.bold(`\n  ${chalk.cyan("●")} Redis — Detailed Health\n`))

  const start = Date.now()
  let version = "unknown"
  let uptimeSeconds = 0
  let connectedClients = 0

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const url = new URL(redisUrl)
      const socket = net.createConnection(
        { host: url.hostname, port: Number(url.port || 6379) },
        () => { socket.write("INFO server\r\nINFO clients\r\n") }
      )
      let data = ""
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString()
        if (data.includes("connected_clients:")) {
          socket.destroy()
          resolve(data)
        }
      })
      socket.once("error", reject)
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("timeout")) })
    })

    const latencyMs = Date.now() - start

    const versionMatch = /redis_version:(.+)/.exec(result)
    const uptimeMatch = /uptime_in_seconds:(.+)/.exec(result)
    const clientsMatch = /connected_clients:(.+)/.exec(result)
    version = versionMatch?.[1]?.trim() ?? "unknown"
    uptimeSeconds = Number.parseInt(uptimeMatch?.[1]?.trim() ?? "0", 10)
    connectedClients = Number.parseInt(clientsMatch?.[1]?.trim() ?? "0", 10)

    const url = new URL(redisUrl)
    const host = `${url.hostname}:${url.port || 6379}`
    const uptimeHours = Math.floor(uptimeSeconds / 3600)
    const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60)
    const uptimeStr = uptimeHours > 0
      ? `${uptimeHours}h ${uptimeMinutes}m`
      : `${uptimeMinutes}m`

    console.log(`  ${chalk.bold("Status")}      ${chalk.green("✓  ok")}`)
    console.log(`  ${chalk.bold("Connection")} ${chalk.cyan(host)}`)
    console.log(`\n  ${chalk.bold("Server")}      Redis ${version}`)
    console.log(`  ${chalk.bold("Uptime")}      ${uptimeStr}`)
    console.log(`  ${chalk.bold("Clients")}     ${connectedClients} connected`)

    const samples = await latencySamples(() => checkRedis(redisUrl))
    renderLatencySamples(samples)
    console.log()

    console.log(chalk.gray(`  Latency is TCP PING/PONG roundtrip.  Initial check: ${latencyMs}ms\n`))
  } catch (err) {
    console.log(`  ${chalk.bold("Status")}  ${chalk.red("✗  error")}`)
    console.log(chalk.red(`\n  ${String(err)}\n`))
    process.exit(1)
  }
}

async function detailTypesense(host: string, port: string): Promise<void> {
  console.log(chalk.bold(`\n  ${chalk.cyan("●")} Typesense — Detailed Health\n`))

  const start = Date.now()
  try {
    const baseUrl = `http://${host}:${port}`
    const apiKey = process.env.TYPESENSE_API_KEY ?? ""
    const headers: Record<string, string> = apiKey ? { "X-TYPESENSE-API-KEY": apiKey } : {}

    const [healthRes, collectionsRes] = await Promise.all([
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) }),
      fetch(`${baseUrl}/collections`, {
        signal: AbortSignal.timeout(3000),
        headers,
      }).catch(() => null),
    ])

    if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`)
    const healthData = (await healthRes.json()) as Record<string, unknown>
    const latencyMs = Date.now() - start

    console.log(`  ${chalk.bold("Status")}       ${chalk.green("✓  ok")}`)
    console.log(`  ${chalk.bold("Connection")}   ${chalk.cyan(`${host}:${port}`)}`)
    console.log(`  ${chalk.bold("Health")}       ${chalk.white(String(healthData.ok ?? true))}`)

    if (collectionsRes?.ok) {
      const collections = (await collectionsRes.json()) as Array<{ name: string; num_documents: number }>
      console.log(`\n  ${chalk.bold("Collections")}  ${collections.length}`)
      for (const col of collections) {
        const docCount = col.num_documents ?? 0
        const docColor = docCount > 0 ? chalk.green : chalk.yellow
        console.log(`    · ${chalk.white(col.name.padEnd(20))} ${docColor(`${docCount} docs`)}`)
      }
      if (collections.length === 0) {
        console.log(chalk.yellow(`    No collections found — run: ibx db reindex`))
      } else {
        const productsCol = collections.find((c) => c.name === "products")
        if (productsCol && productsCol.num_documents === 0) {
          console.log(chalk.yellow(`\n  ⚠  products collection is empty — run: ibx db reindex`))
        }
      }
    } else if (!apiKey) {
      console.log(chalk.gray(`\n  Set TYPESENSE_API_KEY to see collection details`))
    }

    const samples = await latencySamples(() => checkTypesense(host, port))
    renderLatencySamples(samples)
    console.log()

    console.log(chalk.gray(`  Initial check: ${latencyMs}ms\n`))
  } catch (err) {
    console.log(`  ${chalk.bold("Status")}  ${chalk.red("✗  error")}`)
    console.log(chalk.red(`\n  ${String(err)}\n`))
    process.exit(1)
  }
}

async function detailNats(natsUrl: string): Promise<void> {
  console.log(chalk.bold(`\n  ${chalk.cyan("●")} NATS — Detailed Health\n`))

  const start = Date.now()
  try {
    const url = new URL(natsUrl)
    const monitorUrl = `http://${url.hostname}:8222`

    const varzRes = await fetch(`${monitorUrl}/varz`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null)

    const latencyMs = Date.now() - start

    console.log(`  ${chalk.bold("Status")}      ${chalk.green("✓  ok")}`)
    console.log(`  ${chalk.bold("Connection")} ${chalk.cyan(`${url.hostname}:${url.port || 4222}`)}`)
    console.log(`  ${chalk.bold("Monitor")}     ${chalk.cyan(`${monitorUrl}/`)}`)

    if (varzRes?.ok) {
      const varz = (await varzRes.json()) as Record<string, unknown>
      console.log(`\n  ${chalk.bold("Server")}      NATS ${varz.version ?? "unknown"}`)
      console.log(`  ${chalk.bold("Connections")} ${varz.connections ?? 0} active`)
      console.log(`  ${chalk.bold("Subscriptions")} ${varz.subscriptions ?? 0}`)
      const inMsgs = varz.in_msgs ?? 0
      const outMsgs = varz.out_msgs ?? 0
      console.log(`  ${chalk.bold("Messages")}    ${inMsgs} in  /  ${outMsgs} out`)
    }

    const samples = await latencySamples(() => checkNats(natsUrl))
    renderLatencySamples(samples)
    console.log()

    console.log(chalk.gray(`  Latency is TCP connection time.  Initial check: ${latencyMs}ms\n`))
  } catch (err) {
    console.log(`  ${chalk.bold("Status")}  ${chalk.red("✗  error")}`)
    console.log(chalk.red(`\n  ${String(err)}\n`))
    process.exit(1)
  }
}

// ── Summary (all services) ────────────────────────────────────────────────────

function getInfraEnvVars(): { databaseUrl: string; redisUrl: string; typesenseHost: string; typesensePort: string; natsUrl: string } {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  const typesenseHost = process.env.TYPESENSE_HOST
  const typesensePort = process.env.TYPESENSE_PORT ?? "8108"
  const natsUrl = process.env.NATS_URL

  const missing = [
    !databaseUrl && "DATABASE_URL",
    !redisUrl && "REDIS_URL",
    !typesenseHost && "TYPESENSE_HOST",
    !natsUrl && "NATS_URL",
  ].filter(Boolean)

  if (missing.length) {
    console.error(chalk.red(`Missing env vars: ${missing.join(", ")}`))
    process.exit(1)
  }

  return {
    databaseUrl: databaseUrl!,
    redisUrl: redisUrl!,
    typesenseHost: typesenseHost!,
    typesensePort,
    natsUrl: natsUrl!,
  }
}

function printHealthResults(results: ServiceHealth[]): boolean {
  let allOk = true
  for (const r of results) {
    const icon = r.status === "ok" ? chalk.green("✓") : chalk.red("✗")
    const latency = chalk.gray(`${r.latencyMs}ms`)
    const label = r.status === "ok" ? chalk.white(r.service) : chalk.red(r.service)
    const detail = r.error ? chalk.gray(` — ${r.error}`) : ""
    console.log(`  ${icon}  ${label.padEnd(14)} ${latency}${detail}`)
    if (r.status === "error") allOk = false
  }
  return allOk
}

async function showTypesenseIndex(typesenseHost: string, typesensePort: string): Promise<void> {
  const apiKey = process.env.TYPESENSE_API_KEY ?? ""
  if (!apiKey) return

  try {
    const colRes = await fetch(
      `http://${typesenseHost}:${typesensePort}/collections`,
      { signal: AbortSignal.timeout(2000), headers: { "X-TYPESENSE-API-KEY": apiKey } }
    )
    if (!colRes.ok) return

    const collections = (await colRes.json()) as Array<{ name: string; num_documents: number }>
    const productsCol = collections.find((c) => c.name === "products")
    if (productsCol) {
      const count = productsCol.num_documents ?? 0
      const countColor = count > 0 ? chalk.green : chalk.yellow
      console.log(`\n  ${chalk.bold("Search Index")}  ${countColor(`${count} products indexed`)}`)
      if (count === 0) {
        console.log(chalk.yellow(`  ⚠  Run: ibx db reindex`))
      }
    } else if (collections.length === 0) {
      console.log(chalk.yellow(`\n  ⚠  No Typesense collections — run: ibx db reindex`))
    }
  } catch {
    // Non-critical — skip silently
  }
}

async function checkAllSummary(): Promise<void> {
  const { databaseUrl, redisUrl, typesenseHost, typesensePort, natsUrl } = getInfraEnvVars()

  console.log(chalk.bold("\n  ibx svc health\n"))

  const results = await Promise.all([
    checkPostgres(databaseUrl),
    checkRedis(redisUrl),
    checkTypesense(typesenseHost, typesensePort),
    checkNats(natsUrl),
  ])

  const allOk = printHealthResults(results)

  // Show Typesense collection data summary if healthy
  const tsResult = results.find((r) => r.service === "Typesense")
  if (tsResult?.status === "ok") {
    await showTypesenseIndex(typesenseHost, typesensePort)
  }

  console.log()
  if (!allOk) process.exit(1)
}

// ── Status (running services table) ──────────────────────────────────────────

interface InfraCheckResult {
  name: string
  address: string
  result: ServiceHealth
}

interface AppCheckResult {
  name: string
  address: string
  status: string
  latencyMs: number
}

async function collectInfraStatus(): Promise<InfraCheckResult[]> {
  const databaseUrl = process.env.DATABASE_URL ?? ""
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
  const typesenseHost = process.env.TYPESENSE_HOST ?? "localhost"
  const typesensePort = process.env.TYPESENSE_PORT ?? "8108"
  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222"

  const dbUrl = new URL(databaseUrl || "postgresql://localhost:5433/ibatexas")
  const redisUrlParsed = new URL(redisUrl)
  const natsUrlParsed = new URL(natsUrl)

  const infraChecks = [
    { name: "PostgreSQL", address: `${dbUrl.hostname}:${dbUrl.port || 5433}`, check: () => checkPostgres(databaseUrl) },
    { name: "Redis", address: `${redisUrlParsed.hostname}:${redisUrlParsed.port || 6379}`, check: () => checkRedis(redisUrl) },
    { name: "Typesense", address: `http://${typesenseHost}:${typesensePort}`, check: () => checkTypesense(typesenseHost, typesensePort) },
    { name: "NATS", address: `${natsUrlParsed.hostname}:${natsUrlParsed.port || 4222}`, check: () => checkNats(natsUrl) },
  ]

  return Promise.all(
    infraChecks.map(async ({ name, address, check }) => ({
      name,
      address,
      result: await check(),
    }))
  )
}

async function collectAppStatus(): Promise<AppCheckResult[]> {
  return Promise.all(
    Object.values(SERVICES).map(async (svc) => {
      if (!svc.healthUrl) {
        return { name: svc.name, address: `localhost:${svc.port}`, status: "unknown", latencyMs: 0 }
      }
      const start = Date.now()
      try {
        const res = await fetch(svc.healthUrl, { signal: AbortSignal.timeout(2000) })
        return { name: svc.name, address: `localhost:${svc.port}`, status: res.ok ? "ok" : "error", latencyMs: Date.now() - start }
      } catch {
        return { name: svc.name, address: `localhost:${svc.port}`, status: "offline", latencyMs: Date.now() - start }
      }
    })
  )
}

function renderInfraStatusRows(infraResults: InfraCheckResult[], nameW: number, addrW: number, statusW: number): void {
  console.log(chalk.dim("  ─ Infrastructure ─"))
  for (const { name, address, result } of infraResults) {
    const icon = result.status === "ok" ? chalk.green("✓") : chalk.red("✗")
    const status = result.status === "ok" ? chalk.green("ok") : chalk.red("error")
    const ms = chalk.gray(`${result.latencyMs}ms`)
    const errorHint = result.error ? chalk.gray(` (${result.error.substring(0, 30)})`) : ""
    console.log(
      `  ${icon} ${name.padEnd(nameW - 2)}${chalk.cyan(address.padEnd(addrW))}${status.padEnd(statusW + 10)}${ms}${errorHint}`
    )
  }
}

function renderAppStatusRows(appChecks: AppCheckResult[], nameW: number, addrW: number, statusW: number): void {
  console.log(chalk.dim("\n  ─ Services ─"))
  for (const svc of appChecks) {
    let statusColor: string
    let icon: string
    if (svc.status === "ok") {
      icon = chalk.green("✓")
      statusColor = chalk.green("running")
    } else if (svc.status === "unknown") {
      icon = chalk.gray("○")
      statusColor = chalk.gray("no health")
    } else {
      icon = chalk.red("✗")
      statusColor = chalk.red(svc.status)
    }
    const ms = svc.latencyMs > 0 ? chalk.gray(`${svc.latencyMs}ms`) : ""
    console.log(
      `  ${icon} ${svc.name.padEnd(nameW - 2)}${chalk.cyan(svc.address.padEnd(addrW))}${statusColor.padEnd(statusW + 10)}${ms}`
    )
  }
}

async function showStatus(): Promise<void> {
  console.log(chalk.bold("\n  ibx svc status\n"))

  const infraResults = await collectInfraStatus()
  const appChecks = await collectAppStatus()

  const nameW = 20
  const addrW = 28
  const statusW = 10

  console.log(
    `  ${chalk.bold("Name".padEnd(nameW))}${chalk.bold("Address".padEnd(addrW))}${chalk.bold("Status".padEnd(statusW))}${chalk.bold("Latency")}`
  )
  console.log(`  ${"─".repeat(nameW + addrW + statusW + 10)}`)

  renderInfraStatusRows(infraResults, nameW, addrW, statusW)
  renderAppStatusRows(appChecks, nameW, addrW, statusW)

  console.log()
}

// ── Command registration ──────────────────────────────────────────────────────

const VALID_SERVICES = ["postgres", "redis", "typesense", "nats"] as const
type InfraServiceName = typeof VALID_SERVICES[number]

export function registerSvcCommands(svc: Command) {
  svc
    .command("health [service]")
    .description("Check infrastructure health — all services or a specific one")
    .option("-s, --service <name>", `Service to check: ${VALID_SERVICES.join(" | ")}`)
    .action(async (serviceArg: string | undefined, opts: { service?: string }) => {
      const target = (serviceArg ?? opts.service)?.toLowerCase() as InfraServiceName | undefined

      if (!target) {
        await checkAllSummary()
        return
      }

      if (!(VALID_SERVICES as readonly string[]).includes(target)) {
        console.error(
          chalk.red(`Unknown service "${target}". Valid options: ${VALID_SERVICES.join(", ")}`)
        )
        process.exit(1)
      }

      const databaseUrl = process.env.DATABASE_URL ?? ""
      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
      const typesenseHost = process.env.TYPESENSE_HOST ?? "localhost"
      const typesensePort = process.env.TYPESENSE_PORT ?? "8108"
      const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222"

      switch (target) {
        case "postgres": await detailPostgres(databaseUrl); break
        case "redis":    await detailRedis(redisUrl); break
        case "typesense": await detailTypesense(typesenseHost, typesensePort); break
        case "nats":     await detailNats(natsUrl); break
      }
    })

  svc
    .command("status")
    .description("Show running services with addresses and health status")
    .action(showStatus)

  svc
    .command("logs [service]")
    .description("Tail Docker compose logs — all or a specific service (postgres, redis, typesense, nats)")
    .option("-n, --tail <lines>", "Number of lines to show", "50")
    .action(async (service: string | undefined, opts: { tail: string }) => {
      const { execa } = await import("execa")

      const DOCKER_SERVICES: Record<string, string> = {
        postgres: "postgres",
        redis: "redis",
        typesense: "typesense",
        nats: "nats",
      }

      const args = ["compose", "logs", "-f", "--tail", opts.tail]

      if (service) {
        const mapped = DOCKER_SERVICES[service.toLowerCase()]
        if (!mapped) {
          console.error(
            chalk.red(`Unknown service "${service}". Valid: ${Object.keys(DOCKER_SERVICES).join(", ")}`)
          )
          process.exit(1)
        }
        args.push(mapped)
      }

      try {
        await execa("docker", args, { cwd: ROOT, stdio: "inherit" })
      } catch (err) {
        const error = err as { exitCode?: number }
        // SIGINT (Ctrl+C) is expected — don't treat as failure
        if (error.exitCode !== 130) {
          console.error(chalk.red(`docker compose logs failed: ${(err as Error).message}`))
          process.exit(1)
        }
      }
    })
}
