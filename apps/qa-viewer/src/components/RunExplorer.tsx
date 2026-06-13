// Run explorer — load a runs/<runId>/trace.jsonl (file picker; defaults to
// the committed sanitized fixture) → run summary, cost summary (price table
// arithmetic mirrors the harness's attemptCost — unknown models flagged,
// never silently $0), and the full act/llm.call/verify timeline.
// Read-only: traces are artifacts of past runs; nothing here triggers one.

import { useMemo, useState, type ChangeEvent } from "react"
import { decisionColor } from "../lib/colors"
import {
  formatUsd,
  parseTraceJsonl,
  summarizeCost,
  summarizeRun,
  type ParsedTrace,
} from "../lib/trace"
import type { PriceTable, TraceEvent } from "../types"

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
}: {
  initialTrace: ParsedTrace
  initialSource: string
  priceTable: PriceTable | null
}) {
  const [trace, setTrace] = useState(initialTrace)
  const [source, setSource] = useState(initialSource)

  const run = useMemo(() => summarizeRun(trace.events), [trace])
  const cost = useMemo(() => summarizeCost(trace.events, priceTable), [trace, priceTable])

  const firstTs =
    trace.events.length > 0 ? Date.parse(trace.events[0]!.timestamp ?? "") : Number.NaN

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    void file.text().then((text) => {
      setTrace(parseTraceJsonl(text))
      setSource(file.name)
    })
  }

  return (
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
          {trace.events.map((e, i) => {
            const ts = Date.parse(e.timestamp ?? "")
            const decision =
              typeof e["decision"] === "string" ? decisionColor(e["decision"]) : undefined
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
                <td className="trace-table__detail">{eventDetail(e)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
