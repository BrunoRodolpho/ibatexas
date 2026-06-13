// Coverage matrix (DR-5 cell-level view) — kinds × kernel decisions per
// surface, cell state covered / uncovered / waived-* with the THREE waiver
// categories visually distinct (legend always shows all of them, counts
// included, even at zero). Baseline-claimed cells (the committed
// journey-coverage-baseline.json) carry a ring marker; a baseline claim
// whose cell is no longer covered is the coverage gate's regression and is
// highlighted as such here. Read-only: waivers/baseline are edited through
// the governance files + `ibx journey coverage`, never through this app.

import { useState } from "react"
import type {
  CoverageBaseline,
  CoverageCell,
  CoverageCellState,
  CoverageMatrix,
} from "../types"
import { DECISIONS } from "../types"

const STATES: ReadonlyArray<CoverageCellState> = [
  "covered",
  "uncovered",
  "waived-pending-WS4",
  "waived-unadvertised",
  "waived-quarantined",
]

function cellTitle(cell: CoverageCell, baselineClaimed: boolean): string {
  const parts = [`${cell.key}: ${cell.state}`]
  if (cell.coveredBy.length > 0) parts.push(`covered by ${cell.coveredBy.join(", ")}`)
  if (cell.quarantinedBy.length > 0) {
    parts.push(`quarantined: ${cell.quarantinedBy.join(", ")}`)
  }
  if (cell.waiver !== null) parts.push(`waiver: ${cell.waiver.reason}`)
  if (baselineClaimed) parts.push("baseline-claimed")
  return parts.join("\n")
}

function SurfaceTable({
  surface,
  cells,
  baseline,
  onSelect,
}: {
  surface: string
  cells: CoverageCell[]
  baseline: Set<string>
  onSelect: (cell: CoverageCell) => void
}) {
  const kinds = [...new Set(cells.map((c) => c.kind))].sort()
  const byKey = new Map(cells.map((c) => [c.key, c]))
  return (
    <div className="coverage-surface">
      <h3>
        {surface} <span className="coverage-surface__count">({kinds.length} kinds)</span>
      </h3>
      <table className="coverage-table">
        <thead>
          <tr>
            <th>kind</th>
            {DECISIONS.map((d) => (
              <th key={d} className="coverage-table__decision">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {kinds.map((kind) => (
            <tr key={kind}>
              <td className="coverage-table__kind">
                <code>{kind}</code>
              </td>
              {DECISIONS.map((decision) => {
                const cell = byKey.get(`${surface}:${kind}:${decision}`)
                if (cell === undefined) {
                  // Not in the matrix domain (pack policy narrowed the
                  // plausible-decision set for this kind).
                  return (
                    <td key={decision} className="coverage-cell coverage-cell--out">
                      —
                    </td>
                  )
                }
                const claimed = baseline.has(cell.key)
                const regression = claimed && cell.state !== "covered"
                return (
                  <td
                    key={decision}
                    className={[
                      "coverage-cell",
                      `coverage-cell--${cell.state}`,
                      claimed ? "coverage-cell--baseline" : "",
                      regression ? "coverage-cell--regression" : "",
                    ]
                      .filter((c) => c.length > 0)
                      .join(" ")}
                    title={cellTitle(cell, claimed)}
                  >
                    <button type="button" onClick={() => onSelect(cell)}>
                      {cell.state === "covered"
                        ? "●"
                        : cell.state === "uncovered"
                          ? "·"
                          : "w"}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CoverageMatrixView({
  matrix,
  baseline,
}: {
  matrix: CoverageMatrix
  baseline: CoverageBaseline | null
}) {
  const [selected, setSelected] = useState<CoverageCell | null>(null)
  const claimed = new Set(baseline?.covered ?? [])
  const surfaces = [...new Set(matrix.cells.map((c) => c.surface))].sort()

  return (
    <div className="coverage-view">
      <div className="coverage-legend">
        {STATES.map((state) => (
          <span key={state} className={`coverage-legend__item coverage-cell--${state}`}>
            <span className="coverage-legend__swatch" /> {state}{" "}
            <strong>{matrix.totals[state]}</strong>
          </span>
        ))}
        <span className="coverage-legend__item coverage-cell--baseline">
          <span className="coverage-legend__swatch" /> baseline-claimed{" "}
          <strong>{claimed.size}</strong>
        </span>
        <span className="coverage-legend__item">
          total cells <strong>{matrix.totals.cells}</strong>
        </span>
      </div>

      <div className="coverage-body">
        <div className="coverage-tables">
          {surfaces.map((surface) => (
            <SurfaceTable
              key={surface}
              surface={surface}
              cells={matrix.cells.filter((c) => c.surface === surface)}
              baseline={claimed}
              onSelect={setSelected}
            />
          ))}
        </div>

        {selected !== null && (
          <aside className="meta-panel" aria-label="cell details">
            <div className="meta-panel__header">
              <span className={`type-chip coverage-cell--${selected.state}`}>
                {selected.state}
              </span>
              <button
                type="button"
                className="meta-panel__close"
                onClick={() => setSelected(null)}
              >
                ✕
              </button>
            </div>
            <h3 className="meta-panel__title">
              <code>{selected.key}</code>
            </h3>
            <pre className="meta-panel__meta">{JSON.stringify(selected, null, 2)}</pre>
          </aside>
        )}
      </div>

      {matrix.dormantWaivers.length > 0 && (
        <div className="coverage-dormant">
          <h3>Dormant waivers ({matrix.dormantWaivers.length})</h3>
          <p className="coverage-dormant__hint">
            Granted waivers matching no current domain cell (e.g. the WS4 payment
            kinds until WS4 restores them to the chat surface) — visible, never an
            error.
          </p>
          <ul>
            {matrix.dormantWaivers.map((w) => (
              <li key={`${w.kind}:${w.decision ?? "*"}`}>
                <span className={`flag-badge coverage-cell--${w.category}`}>
                  {w.category}
                </span>{" "}
                <code>
                  {w.kind}:{w.decision ?? "*"}
                </code>{" "}
                — {w.reason} <em>(added {w.addedAt})</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
