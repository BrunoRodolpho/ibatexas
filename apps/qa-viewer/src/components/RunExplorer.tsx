// Run explorer — load a runs/<runId>/trace.jsonl (file picker; defaults to
// the committed sanitized fixture) → run summary, cost summary (price table
// arithmetic mirrors the harness's attemptCost — unknown models flagged,
// never silently $0), and the full act/llm.call/verify timeline.
// Read-only: traces are artifacts of past runs; nothing here triggers one.

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react"
import { decisionColor } from "../lib/colors"
import { navigate } from "../lib/nav"
import {
  formatUsd,
  parseTraceJsonl,
  summarizeCost,
  summarizeRun,
  type ParsedTrace,
} from "../lib/trace"
import type { PriceTable, TraceEvent } from "../types"
import { RailGroup, RailSearch, Workbench, type RailItem } from "./FilterRail"

function eventFamily(e: TraceEvent): string {
  return e.type.split(".")[0] ?? "event"
}

function eventSource(e: TraceEvent): string | null {
  return typeof e["source"] === "string" ? e["source"] : null
}

function eventDetail(e: TraceEvent): string {
  switch (e.type) {
    case "preflight.check":
      return `${String(e["check"] ?? "")} — ${String(e["outcome"] ?? "")}`
    case "act.start":
      return `${String(e["act"] ?? "")} [${String(e["actKind"] ?? "")}]`
    case "act.end":
      return (
        `${String(e["act"] ?? "")} [${String(e["actKind"] ?? "")}] — ` +
        `${String(e["outcome"] ?? "")} in ${String(e["duration"] ?? "?")}ms` +
        (typeof e["detail"] === "string" ? ` — ${e["detail"]}` : "")
      )
    case "chat.turn.start":
    case "chat.turn.end":
      return `turn ${String(e["turn"] ?? "?")} (${String(e["sessionId"] ?? "")})${
        e.type === "chat.turn.end" ? ` — ${String(e["outcome"] ?? "")}` : ""
      }`
    case "llm.call":
      return (
        `${String(e["source"] ?? "driver")} · ${String(e["model"] ?? "?")} · ` +
        `${String(e["inputTokens"] ?? 0)} in / ${String(e["outputTokens"] ?? 0)} out`
      )
    case "evidence.capture":
      return `${String(e["evidence"] ?? "")} = ${String(e["detail"] ?? "")}`
    case "verify.outcome":
      return `${String(e["invariant"] ?? "")} — ${String(e["outcome"] ?? "")}` +
        (typeof e["detail"] === "string" ? ` — ${e["detail"]}` : "")
    case "journey.start":
      return String(e["journey"] ?? "")
    case "journey.end":
      return `${String(e["journey"] ?? "")} — ${String(e["outcome"] ?? "")} in ${String(
        e["duration"] ?? "?",
      )}ms`
    default:
      return typeof e["detail"] === "string" ? e["detail"] : ""
  }
}

function eventClass(e: TraceEvent): string {
  const family = e.type.split(".")[0] ?? "event"
  const outcome = typeof e["outcome"] === "string" ? e["outcome"] : null
  return [
    "trace-row",
    `trace-row--${family}`,
    outcome !== null ? `trace-row--${outcome === "pass" ? "pass" : "fail"}` : "",
  ]
    .filter((c) => c.length > 0)
    .join(" ")
}

export function RunExplorer({
  initialTrace,
  initialSource,
  priceTable,
  controls,
  registerLoader,
}: {
  initialTrace: ParsedTrace
  initialSource: string
  priceTable: PriceTable | null
  /** Optional rail header (WS-B RunControls) rendered above the filters. */
  controls?: ReactNode
  /**
   * Hands this view's trace setter to a parent so a sibling (RunControls) can
   * swap in a completed run's trace. Registered once on mount (effect, not
   * render) to avoid a render-time setState.
   */
  registerLoader?: (load: (trace: ParsedTrace, source: string) => void) => void
}) {
  const [trace, setTrace] = useState(initialTrace)
  const [source, setSource] = useState(initialSource)

  const load = (next: ParsedTrace, nextSource: string) => {
    setTrace(next)
    setSource(nextSource)
  }

  useEffect(() => {
    // mount-only: expose this instance's stable loader closure to a parent.
    registerLoader?.(load)
  }, [])

  const run = useMemo(() => summarizeRun(trace.events), [trace])
  const cost = useMemo(() => summarizeCost(trace.events, priceTable), [trace, priceTable])

  const firstTs =
    trace.events.length > 0 ? Date.parse(trace.events[0]!.timestamp ?? "") : Number.NaN

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    void file.text().then((text) => {
      load(parseTraceJsonl(text), file.name)
    })
  }

  // ── Timeline filters (the summaries stay computed over the full trace) ──
  const [families, setFamilies] = useState<ReadonlySet<string>>(new Set())
  const [sources, setSources] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState("")

  const familyItems = useMemo<RailItem[]>(() => {
    const counts = new Map<string, number>()
    for (const e of trace.events) {
      const f = eventFamily(e)
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, count }))
  }, [trace])

  const sourceItems = useMemo<RailItem[]>(() => {
    const counts = new Map<string, number>()
    for (const e of trace.events) {
      const s = eventSource(e)
      if (s !== null) counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, count }))
  }, [trace])

  const visibleEvents = useMemo(() => {
    const q = query.trim().toLowerCase()
    return trace.events.filter((e) => {
      if (families.size > 0 && !families.has(eventFamily(e))) return false
      const src = eventSource(e)
      if (sources.size > 0 && src !== null && !sources.has(src)) return false
      if (q.length > 0 && !`${e.type} ${eventDetail(e)}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [trace, families, sources, query])

  const toggleIn = (set: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void) => (
    id: string,
  ) =>
    set((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const rail = (
    <>
      {controls}
      <RailSearch value={query} onChange={setQuery} placeholder="filter events…" />
      <RailGroup
        title="Event"
        items={familyItems}
        selected={families}
        onToggle={toggleIn(setFamilies)}
        onAll={() => setFamilies(new Set(familyItems.map((i) => i.id)))}
        onNone={() => setFamilies(new Set())}
        emptyHint="no events"
      />
      {sourceItems.length > 0 && (
        <RailGroup
          title="LLM source"
          items={sourceItems}
          selected={sources}
          onToggle={toggleIn(setSources)}
          onAll={() => setSources(new Set(sourceItems.map((i) => i.id)))}
          onNone={() => setSources(new Set())}
        />
      )}
    </>
  )

  return (
    <Workbench rail={rail}>
      <div className="run-explorer">
      <div className="run-explorer__bar">
        <label className="file-picker">
          Load trace.jsonl
          <input type="file" accept=".jsonl,.txt,application/x-ndjson" onChange={onPick} />
        </label>
        <span className="meta-chip">source: {source}</span>
        {trace.badLines > 0 && (
          <span className="meta-chip meta-chip--warn">
            {trace.badLines} unparseable line(s) skipped
          </span>
        )}
        {(families.size > 0 || sources.size > 0 || query.length > 0) && (
          <span className="meta-chip meta-chip--warn">
            showing {visibleEvents.length} of {trace.events.length} events
          </span>
        )}
      </div>

      <div className="run-explorer__summary">
        <div className="summary-card">
          <h3>Run</h3>
          <dl>
            <dt>journey</dt>
            <dd>{run.journeyId ?? "—"}</dd>
            <dt>runId</dt>
            <dd>
              <code>{run.runId ?? "—"}</code>
            </dd>
            <dt>outcome</dt>
            <dd className={run.outcome === "pass" ? "ok" : "bad"}>{run.outcome ?? "—"}</dd>
            <dt>duration</dt>
            <dd>{run.durationMs !== null ? `${run.durationMs}ms` : "—"}</dd>
            <dt>chat turns</dt>
            <dd>{run.turns}</dd>
            <dt>acts</dt>
            <dd>
              {run.acts.pass} pass / {run.acts.fail} fail
            </dd>
            <dt>verify</dt>
            <dd>
              {run.verifies.pass} pass / {run.verifies.fail} fail
            </dd>
          </dl>
        </div>
        <div className="summary-card">
          <h3>Cost</h3>
          <dl>
            <dt>driver</dt>
            <dd>
              {cost.driver.calls} call(s) · {cost.driver.inputTokens} in /{" "}
              {cost.driver.outputTokens} out · {formatUsd(cost.driver.costUsd)}
            </dd>
            <dt>sut</dt>
            <dd>
              {cost.sut.calls} call(s) · {cost.sut.inputTokens} in /{" "}
              {cost.sut.outputTokens} out · {formatUsd(cost.sut.costUsd)}
            </dd>
            <dt>total</dt>
            <dd>
              <strong>{formatUsd(cost.totalUsd)}</strong>
            </dd>
            {cost.unpricedModels.length > 0 && (
              <>
                <dt>unpriced</dt>
                <dd className="bad">{cost.unpricedModels.join(", ")}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <table className="trace-table">
        <thead>
          <tr>
            <th>t+ms</th>
            <th>event</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {visibleEvents.map((e, i) => {
            const ts = Date.parse(e.timestamp ?? "")
            const decision =
              typeof e["decision"] === "string" ? decisionColor(e["decision"]) : undefined
            // Cross-surface jump: a chat turn's sessionId IS the RCA
            // conversation id (turn_trace.conversation_id) — link them.
            const rcaConv =
              e.type.startsWith("chat.turn") && typeof e["sessionId"] === "string"
                ? e["sessionId"]
                : null
            return (
              <tr key={i} className={eventClass(e)}>
                <td className="trace-table__ts">
                  {Number.isFinite(ts) && Number.isFinite(firstTs) ? ts - firstTs : "—"}
                </td>
                <td>
                  <span
                    className="type-chip"
                    style={decision !== undefined ? { borderColor: decision } : undefined}
                  >
                    {e.type}
                  </span>
                </td>
                <td className="trace-table__detail">
                  {eventDetail(e)}
                  {rcaConv !== null && (
                    <button
                      type="button"
                      className="chip chip--mini"
                      onClick={() => navigate({ section: "rca", conv: rcaConv })}
                      title="Open this conversation in RCA turn forensics"
                    >
                      → RCA
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </Workbench>
  )
}
