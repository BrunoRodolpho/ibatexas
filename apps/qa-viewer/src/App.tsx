// QA viewer shell — six tabs (the four T2-4 graphs, the DR-5 coverage
// matrix, the run explorer) over statically served committed artifacts.
// No router, no state library, no write path. Internal QA tool: English UI
// (the pt-BR hard rule covers user-facing product surfaces; recorded in
// the T2-5 decision notes).

import { useEffect, useState, type ReactNode } from "react"
import { CoverageMatrixView } from "./components/CoverageMatrixView"
import { GraphView } from "./components/GraphView"
import { RunExplorer } from "./components/RunExplorer"
import { artifactsBase, fetchArtifactJson, fetchArtifactText, type ArtifactState } from "./lib/artifacts"
import { parseTraceJsonl, type ParsedTrace } from "./lib/trace"
import type { CoverageBaseline, CoverageMatrix, GraphDocument, PriceTable } from "./types"

const TABS = [
  { id: "capability", label: "Capability graph" },
  { id: "journeys", label: "Journey graph" },
  { id: "run", label: "Run graph" },
  { id: "impact", label: "Impact graph" },
  { id: "coverage", label: "Coverage matrix" },
  { id: "run-explorer", label: "Run explorer" },
] as const

type TabId = (typeof TABS)[number]["id"]

const GRAPH_PATHS: Record<string, string> = {
  capability: "graphs/capability.json",
  journeys: "graphs/journeys.json",
  run: "graphs/run-fixture.json",
  impact: "graphs/impact.json",
}

function useArtifact<T>(load: () => Promise<T>): ArtifactState<T> {
  const [state, setState] = useState<ArtifactState<T>>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    load()
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: (err as Error).message })
      })
    return () => {
      cancelled = true
    }
    // intentionally mount-only: each call site passes a stable fetcher.
  }, [])
  return state
}

function Pending<T>({ state, children }: { state: ArtifactState<T>; children: (data: T) => ReactNode }) {
  if (state.status === "loading") return <p className="pending">Loading artifact…</p>
  if (state.status === "error") {
    return (
      <p className="pending pending--error">
        Failed to load artifact: {state.message} (artifacts base: <code>{artifactsBase()}</code>)
      </p>
    )
  }
  return <>{children(state.data)}</>
}

export default function App() {
  const [tab, setTab] = useState<TabId>("capability")

  const capability = useArtifact(() =>
    fetchArtifactJson<GraphDocument>(GRAPH_PATHS["capability"]!),
  )
  const journeys = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["journeys"]!))
  const run = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["run"]!))
  const impact = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["impact"]!))
  const matrix = useArtifact(() => fetchArtifactJson<CoverageMatrix>("coverage-matrix.json"))
  const baseline = useArtifact(() =>
    fetchArtifactJson<CoverageBaseline>("governance/journey-coverage-baseline.json"),
  )
  const priceTable = useArtifact(() =>
    fetchArtifactJson<PriceTable>("governance/price-table.json"),
  )
  const traceFixture = useArtifact<ParsedTrace>(async () =>
    parseTraceJsonl(await fetchArtifactText("runs/run-trace.jsonl")),
  )

  const graphState: Record<string, ArtifactState<GraphDocument>> = {
    capability,
    journeys,
    run,
    impact,
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>IbateXas QA Viewer</h1>
        <span className="app__subtitle">
          read-only · derived artifacts (T2-4 graphs · DR-5 coverage · run traces)
        </span>
        <nav className="tabs" aria-label="views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tabs__tab ${tab === t.id ? "tabs__tab--active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app__main">
        {(tab === "capability" || tab === "journeys" || tab === "run" || tab === "impact") && (
          <Pending state={graphState[tab]!}>{(doc) => <GraphView doc={doc} />}</Pending>
        )}
        {tab === "coverage" && (
          <Pending state={matrix}>
            {(m) => (
              <CoverageMatrixView
                matrix={m}
                baseline={baseline.status === "ready" ? baseline.data : null}
              />
            )}
          </Pending>
        )}
        {tab === "run-explorer" && (
          <Pending state={traceFixture}>
            {(parsed) => (
              <RunExplorer
                initialTrace={parsed}
                initialSource="committed fixture (packages/journeys/graphs/fixtures/run-trace.jsonl)"
                priceTable={priceTable.status === "ready" ? priceTable.data : null}
              />
            )}
          </Pending>
        )}
      </main>
    </div>
  )
}
