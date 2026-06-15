// RunControls (WS-B) — the Run-explorer rail when QA-control is configured.
// Lists runnable scenarios / journeys / agents (search + multi-select +
// select-all + run-all), streams a batch run live (combined log + per-item
// pass/fail), and loads a completed run's trace.jsonl into the explorer.
// Inert (and absent) unless VITE_QA_CONTROL_BASE + _TOKEN are set.

import { useCallback, useEffect, useState } from "react"
import { parseTraceJsonl, type ParsedTrace } from "../lib/trace"
import {
  fetchAgents,
  fetchJourneys,
  fetchRuns,
  fetchScenarios,
  fetchTraceText,
  streamGraphExport,
  streamLint,
  streamRun,
  type AgentEntry,
  type JourneyEntry,
  type QaConfig,
  type RunEntry,
  type RunEvent,
  type RunItem,
  type ScenarioEntry,
} from "../lib/qaControl"
import { RailGroup, RailSection, type RailItem } from "./FilterRail"

const LOG_CAP = 400

function toggle(prev: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function RunControls({
  config,
  onTrace,
}: {
  config: QaConfig
  onTrace: (trace: ParsedTrace, source: string) => void
}) {
  const [journeys, setJourneys] = useState<JourneyEntry[]>([])
  const [scenarios, setScenarios] = useState<ScenarioEntry[]>([])
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [runs, setRuns] = useState<RunEntry[]>([])

  const [selJ, setSelJ] = useState<ReadonlySet<string>>(new Set())
  const [selS, setSelS] = useState<ReadonlySet<string>>(new Set())
  const [selA, setSelA] = useState<ReadonlySet<string>>(new Set())

  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [statuses, setStatuses] = useState<Map<string, { status?: string; runId?: string }>>(
    new Map(),
  )
  const [error, setError] = useState<string | null>(null)

  const refreshRuns = useCallback(() => {
    fetchRuns(config)
      .then(setRuns)
      .catch((e: unknown) => setError((e as Error).message))
  }, [config])

  useEffect(() => {
    Promise.all([
      fetchJourneys(config),
      fetchScenarios(config),
      fetchAgents(config),
      fetchRuns(config),
    ])
      .then(([j, s, a, r]) => {
        setJourneys(j)
        setScenarios(s)
        setAgents(a)
        setRuns(r)
      })
      .catch((e: unknown) => setError((e as Error).message))
  }, [config])

  const appendLog = useCallback((line: string) => {
    setLog((prev) => {
      const next = prev.length >= LOG_CAP ? prev.slice(prev.length - LOG_CAP + 1) : prev
      return [...next, line]
    })
  }, [])

  const loadTrace = useCallback(
    (runId: string) => {
      fetchTraceText(config, runId)
        .then((text) => onTrace(parseTraceJsonl(text), `run ${runId}`))
        .catch((e: unknown) => setError((e as Error).message))
    },
    [config, onTrace],
  )

  // Drive any NDJSON stream to the live log + per-item status; auto-load the
  // last journey trace produced.
  const consume = useCallback(
    async (gen: AsyncGenerator<RunEvent>) => {
      setRunning(true)
      setError(null)
      setLog([])
      setStatuses(new Map())
      let lastRunId: string | undefined
      try {
        for await (const ev of gen) {
          if (ev.type === "log" && ev.line !== undefined) {
            appendLog(ev.line)
          } else if (ev.type === "item.start") {
            appendLog(`▶ ${ev.label ?? ev.id ?? ""}`)
          } else if (ev.type === "item.end") {
            const key = ev.label ?? String(ev.index ?? "")
            setStatuses((prev) =>
              new Map(prev).set(key, { status: ev.status, runId: ev.runId }),
            )
            appendLog(
              `${ev.status === "pass" ? "✓" : "✗"} ${ev.label ?? key} (exit ${ev.exitCode ?? "?"})`,
            )
            if (ev.runId !== undefined) lastRunId = ev.runId
          }
        }
      } catch (e) {
        appendLog(`[error] ${(e as Error).message}`)
        setError((e as Error).message)
      } finally {
        setRunning(false)
        refreshRuns()
        if (lastRunId !== undefined) loadTrace(lastRunId)
      }
    },
    [appendLog, refreshRuns, loadTrace],
  )

  const runItems = (items: RunItem[]) => {
    if (running || items.length === 0) return
    void consume(streamRun(config, { items }))
  }
  const runAll = (all: "journeys" | "scenarios" | "agents") => {
    if (running) return
    void consume(streamRun(config, { all }))
  }

  const activeJourneys = journeys.filter((j) => j.status === "active")
  const jItems: RailItem[] = activeJourneys.map((j) => ({ id: j.id, label: j.id }))
  const sItems: RailItem[] = scenarios.map((s) => ({ id: s.name, label: s.name }))
  const aItems: RailItem[] = agents.map((a) => ({ id: a.id, label: a.displayName }))

  const selectedItems: RunItem[] = [
    ...[...selJ].map((id) => ({ kind: "journey" as const, id })),
    ...[...selS].map((id) => ({ kind: "scenario" as const, id })),
    ...[...selA].map((id) => ({ kind: "agent" as const, id })),
  ]

  return (
    <div className="run-controls">
      <RailSection title="Run controls">
        <div className="run-controls__cmds">
          <button
            type="button"
            className="rail__btn"
            disabled={running}
            onClick={() => void consume(streamLint(config))}
          >
            Lint
          </button>
          <button
            type="button"
            className="rail__btn"
            disabled={running}
            onClick={() => void consume(streamGraphExport(config))}
          >
            Graph export
          </button>
        </div>
        <button
          type="button"
          className="rail__btn rail__btn--primary"
          disabled={running || selectedItems.length === 0}
          onClick={() => runItems(selectedItems)}
        >
          {running ? "Running…" : `Run selected (${selectedItems.length})`}
        </button>
        {error !== null && <p className="run-controls__error">{error}</p>}
      </RailSection>

      <RunSection
        title="Journeys"
        items={jItems}
        selected={selJ}
        setSelected={setSelJ}
        statuses={statuses}
        prefix="journey"
        running={running}
        onRunAll={() => runAll("journeys")}
      />
      <RunSection
        title="Scenarios"
        items={sItems}
        selected={selS}
        setSelected={setSelS}
        statuses={statuses}
        prefix="scenario"
        running={running}
        onRunAll={() => runAll("scenarios")}
      />
      <RunSection
        title="Agents"
        items={aItems}
        selected={selA}
        setSelected={setSelA}
        statuses={statuses}
        prefix="agent"
        running={running}
        onRunAll={() => runAll("agents")}
        hint="needs IBX_AGENTS_ENABLED on the API; observe in console /agents"
      />

      {log.length > 0 && (
        <RailSection title="Live log">
          <pre className="run-controls__log">{log.join("\n")}</pre>
        </RailSection>
      )}

      {runs.length > 0 && (
        <RailSection title={`Recent runs (${runs.length})`}>
          <ul className="rail__list">
            {runs.slice(0, 20).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="run-controls__run-link"
                  disabled={!r.hasTrace}
                  title={r.id}
                  onClick={() => loadTrace(r.id)}
                >
                  {r.id.slice(0, 8)}…
                </button>
              </li>
            ))}
          </ul>
        </RailSection>
      )}
    </div>
  )
}

function RunSection({
  title,
  items,
  selected,
  setSelected,
  statuses,
  prefix,
  running,
  onRunAll,
  hint,
}: {
  title: string
  items: RailItem[]
  selected: ReadonlySet<string>
  setSelected: (next: ReadonlySet<string>) => void
  statuses: Map<string, { status?: string; runId?: string }>
  prefix: string
  running: boolean
  onRunAll: () => void
  hint?: string
}) {
  // Annotate each item with its last run status (tone swatch) when available.
  const decorated: RailItem[] = items.map((it) => {
    const st = statuses.get(`${prefix}:${it.id}`)?.status
    return st !== undefined
      ? { ...it, tone: st === "pass" ? "run-ok" : "run-bad" }
      : it
  })
  return (
    <>
      <RailGroup
        title={`${title} (${items.length})`}
        items={decorated}
        selected={selected}
        onToggle={(id) => setSelected(toggle(selected, id))}
        onAll={() => setSelected(new Set(items.map((i) => i.id)))}
        onNone={() => setSelected(new Set())}
        swatch
        emptyHint="none available"
      />
      <button
        type="button"
        className="rail__btn rail__btn--sm"
        disabled={running || items.length === 0}
        onClick={onRunAll}
      >
        Run all {title.toLowerCase()}
      </button>
      {hint !== undefined && <p className="rail__hint run-controls__hint">{hint}</p>}
    </>
  )
}
