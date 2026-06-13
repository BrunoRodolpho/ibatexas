// QA-control client (WS-B) — the viewer's ONLY write/exec surface, and only
// when explicitly configured. Talks to apps/api's dev-only /internal/qa/*
// routes (see apps/api/src/routes/qa-control.ts) with a bearer token; runs
// stream back as NDJSON consumed via fetch()+ReadableStream (EventSource can't
// send the Authorization header). When VITE_QA_CONTROL_BASE / _TOKEN are unset
// the viewer stays a pure read-only artifact browser (qaConfig() === null).

export interface QaConfig {
  base: string
  token: string
}

export function qaConfig(): QaConfig | null {
  const base = import.meta.env.VITE_QA_CONTROL_BASE
  const token = import.meta.env.VITE_QA_CONTROL_TOKEN
  if (typeof base === "string" && base.length > 0 && typeof token === "string" && token.length > 0) {
    return { base: base.endsWith("/") ? base.slice(0, -1) : base, token }
  }
  return null
}

function authedFetch(cfg: QaConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${cfg.base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(init?.headers ?? {}) },
  })
}

async function getJson<T>(cfg: QaConfig, path: string): Promise<T> {
  const res = await authedFetch(cfg, path)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export interface JourneyEntry {
  id: string
  status: string
}
export interface ScenarioEntry {
  name: string
}
export interface AgentEntry {
  id: string
  displayName: string
  subjects: string[]
}
export interface RunEntry {
  id: string
  hasTrace: boolean
  mtime: number
}

export const fetchJourneys = (cfg: QaConfig): Promise<JourneyEntry[]> =>
  getJson<{ journeys: JourneyEntry[] }>(cfg, "/internal/qa/journeys").then((r) => r.journeys)
export const fetchScenarios = (cfg: QaConfig): Promise<ScenarioEntry[]> =>
  getJson<{ scenarios: ScenarioEntry[] }>(cfg, "/internal/qa/scenarios").then((r) => r.scenarios)
export const fetchAgents = (cfg: QaConfig): Promise<AgentEntry[]> =>
  getJson<{ agents: AgentEntry[] }>(cfg, "/internal/qa/agents").then((r) => r.agents)
export const fetchRuns = (cfg: QaConfig): Promise<RunEntry[]> =>
  getJson<{ runs: RunEntry[] }>(cfg, "/internal/qa/runs").then((r) => r.runs)

export async function fetchTraceText(cfg: QaConfig, runId: string): Promise<string> {
  const res = await authedFetch(cfg, `/internal/qa/runs/${encodeURIComponent(runId)}/trace`)
  if (!res.ok) throw new Error(`trace ${runId} → ${res.status}`)
  return res.text()
}

// ── Streaming run ───────────────────────────────────────────────────────────

export type RunKind = "journey" | "scenario" | "agent"

export interface RunItem {
  kind: RunKind
  id: string
  k?: number
}

/** NDJSON frames emitted by the QA-control batch runner. */
export interface RunEvent {
  type: "batch.start" | "item.start" | "log" | "item.end" | "batch.end"
  index?: number
  total?: number
  kind?: string
  id?: string
  label?: string
  line?: string
  status?: "pass" | "fail"
  exitCode?: number
  runId?: string
}

async function* streamNdjson(
  cfg: QaConfig,
  path: string,
  body: unknown,
): AsyncGenerator<RunEvent> {
  const res = await authedFetch(cfg, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok || res.body === null) throw new Error(`POST ${path} → ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf("\n")
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line.length > 0) {
        try {
          yield JSON.parse(line) as RunEvent
        } catch {
          // ignore non-JSON noise on the stream
        }
      }
      nl = buf.indexOf("\n")
    }
  }
}

export function streamRun(
  cfg: QaConfig,
  body: { items?: RunItem[]; all?: "journeys" | "scenarios" | "agents" },
): AsyncGenerator<RunEvent> {
  return streamNdjson(cfg, "/internal/qa/run", body)
}

export function streamLint(cfg: QaConfig): AsyncGenerator<RunEvent> {
  return streamNdjson(cfg, "/internal/qa/lint", {})
}

export function streamGraphExport(cfg: QaConfig): AsyncGenerator<RunEvent> {
  return streamNdjson(cfg, "/internal/qa/graph-export", {})
}
