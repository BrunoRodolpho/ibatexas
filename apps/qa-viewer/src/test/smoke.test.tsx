// T2-5 acceptance smoke — renders the COMMITTED artifacts (never synthetic
// stand-ins): all four T2-4 graph fixtures render through the real dagre +
// React Flow pipeline with non-empty nodes, the coverage matrix renders the
// three waiver categories distinctly, and the run explorer renders the
// sanitized trace fixture's timeline + cost summary.

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CoverageMatrixView } from "../components/CoverageMatrixView"
import { GraphView } from "../components/GraphView"
import { RunExplorer } from "../components/RunExplorer"
import { parseTraceJsonl } from "../lib/trace"
import type {
  CoverageBaseline,
  CoverageMatrix,
  GraphDocument,
  GraphName,
  PriceTable,
} from "../types"

// node:path resolution (NOT the `new URL(x, import.meta.url)` two-arg form —
// vite statically rewrites that pattern as an asset reference and dynamic
// segments resolve to the literal string "undefined" under vitest).
const HERE = dirname(fileURLToPath(import.meta.url))

function repoFile(rel: string): string {
  // src/test/ → ../../ = apps/qa-viewer, ../../../../ = repo root.
  return resolve(HERE, "../../../..", rel)
}

function appFile(rel: string): string {
  return resolve(HERE, "../..", rel)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

const GRAPH_FIXTURES: Record<GraphName, string> = {
  capability: repoFile("packages/journeys/graphs/capability.json"),
  journeys: repoFile("packages/journeys/graphs/journeys.json"),
  run: repoFile("packages/journeys/graphs/run-fixture.json"),
  impact: repoFile("packages/journeys/graphs/impact.json"),
}

describe("graph views — all four committed T2-4 fixtures", () => {
  for (const [name, path] of Object.entries(GRAPH_FIXTURES)) {
    it(`renders the committed ${name} graph without throwing (non-empty nodes)`, () => {
      const doc = readJson<GraphDocument>(path)
      expect(doc.graph).toBe(name)
      expect(doc.nodes.length).toBeGreaterThan(0)

      const { container } = render(<GraphView doc={doc} />)
      const rendered = container.querySelectorAll(".react-flow__node")
      expect(rendered.length).toBe(doc.nodes.length)
    })
  }

  it("renders the capability roster flags visually distinct", () => {
    const doc = readJson<GraphDocument>(GRAPH_FIXTURES.capability)
    const { container } = render(<GraphView doc={doc} />)
    // FE-D28 (PR #305) advertised order.review.submit — the last
    // registered-but-unadvertised kind — so the committed graph's
    // unadvertised set may legitimately be EMPTY now. The invariant is
    // flag-count EQUALITY with the meta fact, not non-emptiness (the
    // visually-distinct rendering itself stays pinned by the journeys
    // blocked/gap test below, whose classes are non-empty).
    const unadvertised = Array.isArray(doc.meta["unadvertised"])
      ? doc.meta["unadvertised"]
      : []
    expect(
      container.querySelectorAll(".react-flow__node.qa-flag--unadvertised").length,
    ).toBe(unadvertised.length)
  })

  it("renders blocked journeys and gap nodes visually distinct", () => {
    const doc = readJson<GraphDocument>(GRAPH_FIXTURES.journeys)
    const { container } = render(<GraphView doc={doc} />)
    const blockedIds = Array.isArray(doc.meta["blocked"]) ? doc.meta["blocked"] : []
    const gapIds = Array.isArray(doc.meta["gaps"]) ? doc.meta["gaps"] : []
    expect(blockedIds.length).toBeGreaterThan(0)
    expect(gapIds.length).toBeGreaterThan(0)
    expect(container.querySelectorAll(".react-flow__node.qa-flag--blocked").length).toBe(
      blockedIds.length,
    )
    expect(container.querySelectorAll(".react-flow__node.qa-flag--gap").length).toBe(
      gapIds.length,
    )
  })
})

describe("coverage matrix — committed fixture + baseline", () => {
  const matrix = readJson<CoverageMatrix>(appFile("fixtures/coverage-matrix.json"))
  const baseline = readJson<CoverageBaseline>(
    repoFile("packages/journeys/governance/journey-coverage-baseline.json"),
  )

  it("renders all three waiver categories distinctly in the legend", () => {
    render(<CoverageMatrixView matrix={matrix} baseline={baseline} />)
    for (const category of [
      "waived-pending-WS4",
      "waived-unadvertised",
      "waived-quarantined",
    ]) {
      const chips = screen.getAllByText(new RegExp(category))
      expect(chips.length).toBeGreaterThan(0)
      // Each category carries its own CSS state class — distinct, not a
      // single shared "waived" treatment.
      expect(
        chips.some((chip) =>
          (chip.closest(`[class*="coverage-cell--${category}"]`) ?? null) !== null,
        ),
      ).toBe(true)
    }
  })

  it("renders every cell of the committed matrix", () => {
    const { container } = render(<CoverageMatrixView matrix={matrix} baseline={baseline} />)
    expect(matrix.cells.length).toBeGreaterThan(0)
    const rendered = container.querySelectorAll(
      "td.coverage-cell:not(.coverage-cell--out)",
    )
    expect(rendered.length).toBe(matrix.cells.length)
  })

  it("marks baseline-claimed cells", () => {
    const { container } = render(<CoverageMatrixView matrix={matrix} baseline={baseline} />)
    expect(baseline.covered.length).toBeGreaterThan(0)
    expect(container.querySelectorAll("td.coverage-cell--baseline").length).toBe(
      baseline.covered.length,
    )
  })
})

describe("run explorer — committed sanitized trace fixture", () => {
  const traceText = readFileSync(
    repoFile("packages/journeys/graphs/fixtures/run-trace.jsonl"),
    "utf8",
  )
  const priceTable = readJson<PriceTable>(
    repoFile("packages/journeys/governance/price-table.json"),
  )

  it("renders the timeline and a priced cost summary", () => {
    const parsed = parseTraceJsonl(traceText)
    expect(parsed.badLines).toBe(0)
    expect(parsed.events.length).toBeGreaterThan(0)

    const { container } = render(
      <RunExplorer initialTrace={parsed} initialSource="fixture" priceTable={priceTable} />,
    )
    const rows = container.querySelectorAll(".trace-table tbody tr")
    expect(rows.length).toBe(parsed.events.length)

    // Cost summary: driver + sut legs with a real dollar total (the fixture's
    // llm.call events price against the committed table — never "unpriced").
    const costCard = screen.getByText("Cost").closest(".summary-card")
    expect(costCard).not.toBeNull()
    expect(within(costCard as HTMLElement).getByText("driver")).toBeDefined()
    expect(within(costCard as HTMLElement).getByText("sut")).toBeDefined()
    expect((costCard as HTMLElement).textContent).toMatch(/\$\d+\.\d{4}/)
    expect((costCard as HTMLElement).textContent).not.toContain("unpriced")
  })
})
