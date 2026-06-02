// ibx status — one fast, readable view of the whole stack: the infra services,
// the api (which reflects conductor readiness), and where to watch the logs.
// A friendlier top-level companion to `ibx svc health` that also probes the api
// and surfaces the VictoriaLogs UI.

import type { Command } from "commander"
import chalk from "chalk"
import { checkPostgres, checkRedis, checkTypesense, checkNats, checkVictoriaLogs, type ServiceHealth } from "./svc.js"

const VICTORIALOGS_URL = process.env.VICTORIALOGS_URL ?? "http://localhost:9428"

async function probeApi(): Promise<ServiceHealth> {
  const start = Date.now()
  const base = process.env.API_HEALTH_URL ?? "http://localhost:3001/health"
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(5000) })
    // /health reflects Redis/Postgres/NATS/Typesense + DLQ/outbox + a live api
    // (and therefore a bootstrapped conductor).
    return res.ok
      ? { service: "api + conductor", status: "ok", latencyMs: Date.now() - start }
      : { service: "api + conductor", status: "error", latencyMs: Date.now() - start, error: `HTTP ${res.status}` }
  } catch (err) {
    return {
      service: "api + conductor",
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function row(r: ServiceHealth): void {
  const icon = r.status === "ok" ? chalk.green("✓") : chalk.red("✗")
  const label = r.status === "ok" ? chalk.white(r.service) : chalk.red(r.service)
  const detail = r.error ? chalk.gray(` — ${r.error}`) : ""
  console.log(`  ${icon}  ${label.padEnd(18)} ${chalk.gray(`${r.latencyMs}ms`)}${detail}`)
}

export function registerStatusCommands(status: Command): void {
  status.description("Fast stack health — infra services + api/conductor + where to watch logs").action(async () => {
    const databaseUrl = process.env.DATABASE_URL
    const redisUrl = process.env.REDIS_URL
    const typesenseHost = process.env.TYPESENSE_HOST
    const typesensePort = process.env.TYPESENSE_PORT ?? "8108"
    const natsUrl = process.env.NATS_URL

    console.log(chalk.bold("\n  ibx status\n"))

    const infra = await Promise.all([
      databaseUrl ? checkPostgres(databaseUrl) : skip("PostgreSQL", "DATABASE_URL"),
      redisUrl ? checkRedis(redisUrl) : skip("Redis", "REDIS_URL"),
      typesenseHost ? checkTypesense(typesenseHost, typesensePort) : skip("Typesense", "TYPESENSE_HOST"),
      natsUrl ? checkNats(natsUrl) : skip("NATS", "NATS_URL"),
      checkVictoriaLogs(VICTORIALOGS_URL),
    ])
    for (const r of infra) row(r)

    console.log()
    row(await probeApi())

    const allOk = [...infra].every((r) => r.status === "ok")
    console.log()
    console.log(`  ${chalk.bold("Logs UI")}   ${chalk.cyan(VICTORIALOGS_URL)}   ${chalk.dim("(LogsQL + web UI)")}`)
    console.log(`  ${chalk.bold("Watch")}     ${chalk.dim("ibx logs --follow   ·   ibx obs decisions -f")}`)
    console.log()
    if (!allOk) process.exitCode = 1
  })
}

function skip(service: string, envVar: string): ServiceHealth {
  return { service, status: "error", latencyMs: 0, error: `${envVar} not set` }
}
