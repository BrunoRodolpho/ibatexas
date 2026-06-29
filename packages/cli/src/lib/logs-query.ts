// Shared VictoriaLogs LogsQL client for the operator log commands (ibx logs / ibx obs).
//
// Reads the structured pino stream the api ships to VictoriaLogs (Layer 3). The
// api ingests with _msg_field=msg, _time_field=time, _stream_fields=component,event,
// so VictoriaLogs returns each entry as a JSON object with `_time`, `_msg`, and the
// model fields (level, component, event, correlationId, intentHash, …) at top level.

import chalk from "chalk"

export const VICTORIALOGS_URL = process.env.VICTORIALOGS_URL ?? "http://localhost:9428"

// pino numeric levels ↔ names.
const LEVEL_NUM: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }
const LEVEL_NAME = (n: number): string => {
  if (n >= 60) return "FATAL"
  if (n >= 50) return "ERROR"
  if (n >= 40) return "WARN"
  if (n >= 30) return "INFO"
  if (n >= 20) return "DEBUG"
  return "TRACE"
}
const levelColor = (n: number): ((s: string) => string) => {
  if (n >= 50) return chalk.red
  if (n >= 40) return chalk.yellow
  if (n >= 30) return chalk.green
  return chalk.gray
}

/** Strip trailing slashes (linear scan; avoids the super-linear backtracking of a `/\/+$/` replace). */
function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === "/") end--
  return s.slice(0, end)
}

export interface LogFilters {
  /** component tag (kernel/conductor/route/subscriber/job/…) — positional or --component */
  component?: string
  /** level name; matches that level AND above (warn → warn+error+fatal) */
  level?: string
  /** correlationId == conductor turnId — one turn's lines */
  turn?: string
  /** structured event name (decision/refusal/turn/ledger/…) */
  event?: string
  /** intent content digest — joins to the intent_audit row */
  intentHash?: string
  /** time window, LogsQL duration (5m, 2h, 1d). Default 1h. */
  since?: string
  /** raw LogsQL — escape hatch, ANDed with the structured filters */
  raw?: string
}

/** Build a LogsQL query string from structured filters. */
export function buildLogsQL(f: LogFilters): string {
  const parts: string[] = []
  parts.push(`_time:${f.since && /^\d+[smhd]$/.test(f.since) ? f.since : "1h"}`)
  if (f.component) parts.push(`component:=${JSON.stringify(f.component)}`)
  if (f.event) parts.push(`event:=${JSON.stringify(f.event)}`)
  if (f.turn) parts.push(`correlationId:=${JSON.stringify(f.turn)}`)
  if (f.intentHash) parts.push(`intentHash:=${JSON.stringify(f.intentHash)}`)
  if (f.level) {
    const n = LEVEL_NUM[f.level.toLowerCase()]
    if (n) parts.push(`level:>=${n}`)
  }
  if (f.raw) parts.push(`(${f.raw})`)
  return parts.join(" ")
}

export interface LogEntry {
  _time?: string
  _msg?: string
  level?: number
  component?: string
  event?: string
  correlationId?: string
  intentHash?: string
  [k: string]: unknown
}

/** Render one log entry the way the dev terminal would (colorized by level). */
export function renderLogLine(e: LogEntry): string {
  const lvl = typeof e.level === "number" ? e.level : 30
  const time = (e._time ?? "").replace("T", " ").replace("Z", "")
  const tag = [e.component, e.event].filter(Boolean).join("/")
  const known = new Set(["_time", "_msg", "_stream", "_stream_id", "level", "time", "msg", "component", "event", "pid", "hostname"])
  const extras = Object.entries(e)
    .filter(([k, v]) => !known.has(k) && v !== undefined && v !== null && typeof v !== "object")
    .map(([k, v]) => `${chalk.dim(k)}=${String(v)}`)
    .join(" ")
  return [
    chalk.dim(time),
    levelColor(lvl)(LEVEL_NAME(lvl).padEnd(5)),
    tag ? chalk.cyan(tag) : "",
    e._msg ?? "",
    extras ? chalk.dim(`{ ${extras} }`) : "",
  ]
    .filter(Boolean)
    .join("  ")
}

/** One-shot query → most-recent entries (chronological). Throws on connection error. */
export async function queryLogs(query: string, limit = 200): Promise<LogEntry[]> {
  const url = `${stripTrailingSlashes(VICTORIALOGS_URL)}/select/logsql/query`
  const body = new URLSearchParams({ query, limit: String(limit) })
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`VictoriaLogs query failed: HTTP ${res.status} ${await res.text().catch(() => "")}`)
  const text = await res.text()
  const entries = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEntry)
  // VictoriaLogs returns newest-first for a limited query; show oldest-first.
  return entries.reverse()
}

/** Live tail (`/select/logsql/tail`). Calls onLine per entry until the signal aborts. */
export async function tailLogs(query: string, onLine: (e: LogEntry) => void, signal: AbortSignal): Promise<void> {
  const url = `${stripTrailingSlashes(VICTORIALOGS_URL)}/select/logsql/tail`
  const body = new URLSearchParams({ query })
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`VictoriaLogs tail failed: HTTP ${res.status}`)
  const decoder = new TextDecoder()
  let buf = ""
  // Node's fetch body is an async-iterable web stream.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        try {
          onLine(JSON.parse(line) as LogEntry)
        } catch {
          // skip malformed line
        }
      }
    }
  }
}

/** Friendly hint shown when VictoriaLogs can't be reached. */
export function unreachableHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    `${chalk.red("✗")} Could not reach VictoriaLogs at ${chalk.cyan(VICTORIALOGS_URL)}\n` +
    `  ${chalk.dim(msg)}\n` +
    `  ${chalk.dim("Is the stack up? Try:")} ${chalk.bold("ibx dev start")}  ${chalk.dim("·")}  ${chalk.bold("ibx svc health")}`
  )
}
