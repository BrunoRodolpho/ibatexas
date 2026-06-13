// Artifact type mirrors — the QA viewer consumes COMMITTED JSON artifacts
// over fetch and never imports `@ibatexas/journeys` (the journeys package is
// test-plane only — "never imported by apps/*" — and its barrel drags in
// node-only deps). These shapes mirror, field for field:
//
//   * GraphDocument        → packages/journeys/src/graphs/contract.ts (T2-4)
//   * CoverageMatrix       → coverageMatrixView() in
//                            packages/journeys/src/gates/coverage.ts (T1a-3)
//   * CoverageBaseline     → journey-coverage-baseline.json ({covered: []})
//   * TraceEvent           → runs/<runId>/trace.jsonl lines written by
//                            packages/journeys/src/harness/run-journey-cli.ts
//   * PriceTable           → packages/journeys/governance/price-table.json
//
// A contract change upstream shows up here as a rendering gap, never a crash:
// every consumer treats `meta`/extra fields as open bags.

// ── Graph documents (the ONE T2-4 contract) ─────────────────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type GraphName = "capability" | "journeys" | "run" | "impact"

export interface GraphNode {
  id: string
  type: string
  label: string
  meta?: Record<string, JsonValue>
}

export interface GraphEdge {
  from: string
  to: string
  type: string
  meta?: Record<string, JsonValue>
}

export interface GraphDocument {
  version: 1
  graph: GraphName
  meta: Record<string, JsonValue>
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ── Kernel decisions (canonical order = JOURNEY_EXPECT_DECISIONS) ───────────

export const DECISIONS = [
  "EXECUTE",
  "REFUSE",
  "ESCALATE",
  "REQUEST_CONFIRMATION",
  "DEFER",
  "REWRITE",
] as const

export type Decision = (typeof DECISIONS)[number]

// ── Coverage matrix (DR-5 cell-level view) ──────────────────────────────────

export const WAIVER_CATEGORIES = [
  "waived-pending-WS4",
  "waived-unadvertised",
  "waived-quarantined",
] as const

export type WaiverCategory = (typeof WAIVER_CATEGORIES)[number]

export type CoverageCellState = "covered" | "uncovered" | WaiverCategory

export interface CoverageCell {
  key: string
  surface: "chat" | "staff-http"
  kind: string
  decision: Decision
  state: CoverageCellState
  coveredBy: string[]
  quarantinedBy: string[]
  waiver: { category: WaiverCategory; reason: string; addedAt: string | null } | null
}

export interface CoverageWaiver {
  kind: string
  decision?: Decision | "*"
  category: WaiverCategory
  reason: string
  addedAt: string
}

export interface CoverageTotals {
  cells: number
  covered: number
  uncovered: number
  "waived-pending-WS4": number
  "waived-unadvertised": number
  "waived-quarantined": number
}

export interface CoverageMatrix {
  totals: CoverageTotals
  cells: CoverageCell[]
  dormantWaivers: CoverageWaiver[]
}

export interface CoverageBaseline {
  covered: string[]
}

// ── Run trace (runs/<runId>/trace.jsonl) ────────────────────────────────────

/** One JSONL line — `type` discriminates; everything else is an open bag. */
export interface TraceEvent {
  type: string
  timestamp: string
  [key: string]: JsonValue | undefined
}

export interface PriceTable {
  models: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }>
}
