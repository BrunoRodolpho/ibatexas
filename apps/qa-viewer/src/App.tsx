// Investigation Workbench shell — three sections in a grouped top nav:
//   · QA       the original six views (graphs, coverage, run explorer)
//   · RCA      live turn forensics (turn_trace + intent_audit + VictoriaLogs)
//   · Prompts  navigate + edit every ibatexas prompt (override store)
// Internal QA tool: English UI (the pt-BR hard rule covers product surfaces).
// Read-only by default; RCA reads + prompt writes go through the dev-only
// bearer bridge (qaControl.ts) and self-disable when it is unconfigured.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { CoverageMatrixView } from "./components/CoverageMatrixView"
import { GraphView } from "./components/GraphView"
import { PromptsWorkbench } from "./components/PromptsWorkbench"
import { RcaWorkbench } from "./components/RcaWorkbench"
import { RunControls } from "./components/RunControls"
import { RunExplorer } from "./components/RunExplorer"
import { artifactsBase, fetchArtifactJson, fetchArtifactText, type ArtifactState } from "./lib/artifacts"
import { currentRoute, navigate } from "./lib/nav"
import { qaConfig } from "./lib/qaControl"
import { applyTheme, isDark, type ThemeChoice } from "./lib/theme"
import { parseTraceJsonl, type ParsedTrace } from "./lib/trace"
import type { CoverageBaseline, CoverageMatrix, GraphDocument, PriceTable } from "./types"

const SECTIONS = [
  { id: "qa", label: "QA" },
  { id: "rca", label: "RCA · Turns" },
  { id: "prompts", label: "Prompts" },
] as const
type SectionId = (typeof SECTIONS)[number]["id"]

const QA_TABS = [
  { id: "capability", label: "Capability graph" },
  { id: "journeys", label: "Journey graph" },
  { id: "run", label: "Run graph" },
  { id: "impact", label: "Impact graph" },
  { id: "coverage", label: "Coverage matrix" },
  { id: "run-explorer", label: "Run explorer" },
] as const
type QaTabId = (typeof QA_TABS)[number]["id"]

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

const isQaTab = (tab: string | undefined): tab is QaTabId =>
  QA_TABS.some((t) => t.id === tab)

export default function App() {
  // The URL hash is the shared address space (lib/nav.ts): it picks the
  // initial section/tab, and cross-tab jumps from inside a section (run
  // trace → RCA, LLM call → Prompts) land here through hashchange.
  const [section, setSection] = useState<SectionId>(() => currentRoute()?.section ?? "qa")
  const [qaTab, setQaTab] = useState<QaTabId>(() => {
    const r = currentRoute()
    return r?.section === "qa" && isQaTab(r.tab) ? r.tab : "capability"
  })
  useEffect(() => {
    const onHash = () => {
      const r = currentRoute()
      if (r === null) return
      setSection(r.section)
      if (r.section === "qa" && isQaTab(r.tab)) setQaTab(r.tab)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const [theme, setTheme] = useState<ThemeChoice>("system")
  useEffect(() => applyTheme(theme), [theme])
  const dark = isDark(theme)

  // WS-B: when QA-control is configured, the run-explorer rail gains RunControls.
  const qa = qaConfig()
  const loaderRef = useRef<((trace: ParsedTrace, source: string) => void) | null>(null)

  const capability = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["capability"]!))
  const journeys = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["journeys"]!))
  const run = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["run"]!))
  const impact = useArtifact(() => fetchArtifactJson<GraphDocument>(GRAPH_PATHS["impact"]!))
  const matrix = useArtifact(() => fetchArtifactJson<CoverageMatrix>("coverage-matrix.json"))
  const baseline = useArtifact(() =>
    fetchArtifactJson<CoverageBaseline>("governance/journey-coverage-baseline.json"),
  )
  const priceTable = useArtifact(() => fetchArtifactJson<PriceTable>("governance/price-table.json"))
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
      <header className="app__bar">
        <div className="brand">
          <span className="brand__lens" aria-hidden="true">
            ◉
          </span>
          Investigation Workbench
          <small>ibatexas · qa-viewer</small>
        </div>
        <nav className="primary-nav" aria-label="section">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`nav-tab ${section === s.id ? "nav-tab--active" : ""}`}
              onClick={() => {
                setSection(s.id)
                navigate({ section: s.id })
              }}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <span className="app__bar-spacer" />
        <span className={`conn-dot ${qa !== null ? "conn-dot--live" : "conn-dot--off"}`}>
          bridge {qa !== null ? "on" : "off"}
        </span>
        <span className="env-pill">DEV · :3010</span>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme(dark ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          {dark ? "☀ Light" : "☾ Dark"}
        </button>
      </header>

      {section === "qa" && (
        <div className="subnav" role="tablist" aria-label="QA views">
          {QA_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={qaTab === t.id}
              className={`subnav__tab ${qaTab === t.id ? "subnav__tab--active" : ""}`}
              onClick={() => {
                setQaTab(t.id)
                navigate({ section: "qa", tab: t.id })
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <main className="app__main">
        {section === "rca" && <RcaWorkbench />}
        {section === "prompts" && <PromptsWorkbench />}
        {section === "qa" && (
          <>
            {(qaTab === "capability" ||
              qaTab === "journeys" ||
              qaTab === "run" ||
              qaTab === "impact") && (
              <Pending state={graphState[qaTab]!}>{(doc) => <GraphView doc={doc} />}</Pending>
            )}
            {qaTab === "coverage" && (
              <Pending state={matrix}>
                {(m) => (
                  <CoverageMatrixView
                    matrix={m}
                    baseline={baseline.status === "ready" ? baseline.data : null}
                  />
                )}
              </Pending>
            )}
            {qaTab === "run-explorer" && (
              <Pending state={traceFixture}>
                {(parsed) => (
                  <RunExplorer
                    initialTrace={parsed}
                    initialSource="committed fixture (packages/journeys/graphs/fixtures/run-trace.jsonl)"
                    priceTable={priceTable.status === "ready" ? priceTable.data : null}
                    registerLoader={(fn) => {
                      loaderRef.current = fn
                    }}
                    controls={
                      qa !== null ? (
                        <RunControls config={qa} onTrace={(t, s) => loaderRef.current?.(t, s)} />
                      ) : undefined
                    }
                  />
                )}
              </Pending>
            )}
          </>
        )}
      </main>
    </div>
  )
}
