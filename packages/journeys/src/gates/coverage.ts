// gates/coverage.ts — the coverage gate behind `ibx journey coverage` (T1a-3).
//
// Cell-level coverage matrix per DR-5 (decisions.md D-001):
//
//   domain = CHAT_DRIVABLE_TOOL_KINDS × plausible-decision set   (chat cells)
//          ∪ STAFF_ROUTE_KINDS        × plausible-decision set   (staff-http cells)
//
// The plausible-decision set per kind is derived from the owning composed
// Pack's policy metadata (`readGuardMetadata` over the bundle's guards) when
// EVERY guard declares a determinable emit axis; otherwise — and this is the
// state of all six first-party packs today, which attach no GuardMetadata —
// the full 6-decision set (`JOURNEY_EXPECT_DECISIONS`) is the per-kind
// domain. The introspection seam is real code, so packs that adopt
// `withMetadata` narrow their cells without changes here.
//
// Coverage marking: a journey's `expects[]` entries mark cells covered iff
// the journey is `status: active` AND not quarantined. Mapping mirrors the
// lint reachability surfaces: chat acts claim chat cells (kind ∈
// CHAT_DRIVABLE_TOOL_KINDS), staff http acts claim staff-http cells (kind ∈
// STAFF_ROUTE_KINDS). Expects outside the matrix domain (system kinds,
// public-http-produced kinds) are reported per journey as
// `unmatchedExpects`, never silently dropped.
//
// Waivers (`packages/journeys/governance/journey-coverage-waivers.json`):
// `{kind, decision?|'*', category, reason, addedAt}` with categories
// `waived-pending-WS4 | waived-unadvertised | waived-quarantined`. A waiver
// whose kind/decision matches no domain cell is DORMANT — reported in
// `dormantWaivers` (e.g. the two WS4 payment kinds until WS4 restores them
// to the chat surface), never an error.
//
// Quarantine: cells claimed ONLY by quarantined journeys become
// `waived-quarantined` in the report — VISIBLE, never silently covered.
// Quarantine state arrives via `options.quarantined` (the minimal seam);
// Phase 1b's flake ledger owns the authoritative quarantine list and feeds
// it through this option.
//
// Baseline (`packages/journeys/governance/journey-coverage-baseline.json`,
// `{"covered": ["<surface>:<kind>:<decision>", …]}`): covered→uncovered is a
// REGRESSION and fails `--verify-file` (exit 1). Baseline-claimed cells that
// are now `waived-quarantined` are surfaced (`quarantinedClaims`) but do not
// fail — the flake ledger owns their resolution. Uncovered-but-never-covered
// cells are reported (`newlyCovered` for the inverse), not failed, until the
// baseline claims them.
//
// Two views (read-only acts produce no envelopes, so the cell matrix alone
// cannot show every journey): `coverageMatrixView` (coverage-matrix.json,
// cell-level) and `journeyPassView` (per-journey status summary).

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { DecisionKind } from "@adjudicate/core"
import { readGuardMetadata } from "@adjudicate/core/kernel"
import {
  CHAT_DRIVABLE_TOOL_KINDS,
  IBATEXAS_COMPOSED_PACKS,
} from "@ibatexas/packs-composed"

import {
  DEFAULT_JOURNEYS_DIR,
  INTENT_KIND_PATTERN,
  JOURNEY_EXPECT_DECISIONS,
  JourneyLoadError,
  loadJourneys,
  type Journey,
  type JourneyStatus,
} from "../schema/index.js"
import { STAFF_ROUTE_KINDS } from "./lint.js"

// ── Waivers ──────────────────────────────────────────────────────────────────

export const WAIVER_CATEGORIES = [
  "waived-pending-WS4",
  "waived-unadvertised",
  "waived-quarantined",
] as const

export type WaiverCategory = (typeof WAIVER_CATEGORIES)[number]

const WaiverEntrySchema = z
  .object({
    kind: z.string().regex(INTENT_KIND_PATTERN),
    /** Absent ≙ `"*"` — the waiver covers every decision cell of the kind. */
    decision: z.union([z.enum(JOURNEY_EXPECT_DECISIONS), z.literal("*")]).optional(),
    category: z.enum(WAIVER_CATEGORIES),
    reason: z.string().min(1),
    /** ISO date (YYYY-MM-DD…) the waiver was granted. */
    addedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  })
  .strict()

export const WaiversFileSchema = z.array(WaiverEntrySchema)

export type CoverageWaiver = z.infer<typeof WaiverEntrySchema>

/**
 * The committed waivers file (binding path):
 * `packages/journeys/governance/journey-coverage-waivers.json`. Resolved
 * relative to this module so it works from both `src/` and `dist/`.
 */
export const DEFAULT_COVERAGE_WAIVERS_PATH = fileURLToPath(
  new URL("../../governance/journey-coverage-waivers.json", import.meta.url),
)

// ── Plausible-decision derivation (pack policy introspection) ────────────────

type AnyGuard = (envelope: never, state: never) => unknown

interface IntrospectablePack {
  readonly id: string
  readonly intents: ReadonlyArray<string>
  readonly policy: {
    readonly stateGuards: ReadonlyArray<AnyGuard>
    readonly authGuards: ReadonlyArray<AnyGuard>
    readonly business: ReadonlyArray<AnyGuard>
    readonly default: "REFUSE" | "EXECUTE"
  }
}

const COMPOSED: ReadonlyArray<IntrospectablePack> = IBATEXAS_COMPOSED_PACKS

/**
 * The decision(s) a guard can emit, when its `GuardMetadata.description`
 * makes that determinable. `null` = opaque on the emit axis (no metadata,
 * `opaque` variant, `threshold` without `emits`, or an unknown
 * forward-compat variant — tooling MUST tolerate those per ADR-105).
 */
function guardEmits(guard: AnyGuard): ReadonlyArray<DecisionKind> | null {
  const description = readGuardMetadata(guard)?.description
  if (description === undefined) return null
  switch (description.kind) {
    case "threshold":
      return description.emits === undefined ? null : [description.emits]
    case "state_defer":
      return ["DEFER"]
    case "system_taint":
      return ["REFUSE"]
    case "rewrite":
      return ["REWRITE"]
    case "data_classification":
      return [description.action]
    default:
      return null
  }
}

/**
 * Per-kind plausible decision set, derived from the owning composed Pack's
 * policy. Introspectable only when EVERY guard in the bundle declares a
 * determinable emit axis: then the set is `union(guard emits) ∪
 * {bundle.default} ∪ {REFUSE}` (REFUSE is always plausible — the taint
 * policy and the always-on ledger refuse outside the guard chain).
 * Otherwise — including kinds owned by no composed pack — the full
 * 6-decision set. Result is in `JOURNEY_EXPECT_DECISIONS` canonical order.
 */
export function plausibleDecisions(kind: string): ReadonlyArray<DecisionKind> {
  const pack = COMPOSED.find((p) => p.intents.includes(kind))
  if (pack === undefined) return JOURNEY_EXPECT_DECISIONS

  const emitted = new Set<DecisionKind>()
  const guards = [
    ...pack.policy.stateGuards,
    ...pack.policy.authGuards,
    ...pack.policy.business,
  ]
  for (const guard of guards) {
    const emits = guardEmits(guard)
    if (emits === null) return JOURNEY_EXPECT_DECISIONS // opaque → full set
    for (const decision of emits) emitted.add(decision)
  }
  emitted.add(pack.policy.default)
  emitted.add("REFUSE")
  return JOURNEY_EXPECT_DECISIONS.filter((d) => emitted.has(d))
}

// ── Cells ────────────────────────────────────────────────────────────────────

export type CoverageSurface = "chat" | "staff-http"

export type CoverageCellState = "covered" | "uncovered" | WaiverCategory

/** Stable cell identity: `<surface>:<kind>:<decision>` (the baseline unit). */
export function coverageCellKey(
  surface: CoverageSurface,
  kind: string,
  decision: DecisionKind,
): string {
  return `${surface}:${kind}:${decision}`
}

export interface CoverageCell {
  key: string
  surface: CoverageSurface
  kind: string
  decision: DecisionKind
  state: CoverageCellState
  /** Active, non-quarantined journey ids whose expects claim this cell. */
  coveredBy: string[]
  /** Quarantined journey ids whose expects claim this cell (always visible). */
  quarantinedBy: string[]
  /** The waiver explaining a waived state (file-granted or synthesized). */
  waiver: { category: WaiverCategory; reason: string; addedAt: string | null } | null
}

// ── Journey-pass view entries ────────────────────────────────────────────────

export interface JourneyPassEntry {
  id: string
  status: JourneyStatus
  quarantined: boolean
  /** Contributes coverage iff `status === "active"` and not quarantined. */
  counted: boolean
  /** No `expects[]` — read-only acts produce no envelopes; verify-only. */
  verifyOnly: boolean
  /** Domain cells this journey's expects map to (claimed, not necessarily counted). */
  claimedCells: string[]
  /** Expects that map to no domain cell (system kinds, public-http kinds…). */
  unmatchedExpects: Array<{ intentKind: string; decision: DecisionKind }>
}

// ── Report ───────────────────────────────────────────────────────────────────

export type CoverageProblemCode =
  | "registry_unreadable"
  | "journey_invalid"
  | "waivers_unreadable"
  | "waivers_invalid"

export interface CoverageProblem {
  code: CoverageProblemCode
  file: string
  message: string
}

export interface CoverageTotals {
  cells: number
  covered: number
  uncovered: number
  "waived-pending-WS4": number
  "waived-unadvertised": number
  "waived-quarantined": number
}

export interface JourneyCoverageReport {
  ok: boolean
  totals: CoverageTotals
  cells: CoverageCell[]
  /** The journey-pass view (every journey, including blocked/quarantined). */
  journeys: JourneyPassEntry[]
  /** File waivers matching zero domain cells (e.g. WS4 kinds pre-restore). */
  dormantWaivers: CoverageWaiver[]
  problems: CoverageProblem[]
}

export interface ComputeCoverageOptions {
  /** Registry dir override (default: `packages/journeys/journeys/`). */
  dir?: string
  /** Waivers file override (default: the committed governance file). */
  waiversPath?: string
  /**
   * Quarantined journey ids — the minimal seam. Phase 1b's flake ledger
   * owns the authoritative quarantine state and supplies this list.
   */
  quarantined?: ReadonlyArray<string>
}

/** Build the empty domain matrix (every cell `uncovered`). */
function buildCells(): CoverageCell[] {
  const cells: CoverageCell[] = []
  const push = (surface: CoverageSurface, kind: string): void => {
    for (const decision of plausibleDecisions(kind)) {
      cells.push({
        key: coverageCellKey(surface, kind, decision),
        surface,
        kind,
        decision,
        state: "uncovered",
        coveredBy: [],
        quarantinedBy: [],
        waiver: null,
      })
    }
  }
  for (const kind of CHAT_DRIVABLE_TOOL_KINDS) push("chat", kind)
  for (const kind of STAFF_ROUTE_KINDS) push("staff-http", kind)
  return cells
}

/** Load + validate the waivers file, recording any failure as a problem. */
async function loadCoverageWaivers(
  waiversPath: string,
  problems: CoverageProblem[],
): Promise<CoverageWaiver[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(waiversPath, "utf8"))
    const parsed = WaiversFileSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    problems.push({
      code: "waivers_invalid",
      file: waiversPath,
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    })
    return []
  } catch (err) {
    problems.push({
      code: err instanceof SyntaxError ? "waivers_invalid" : "waivers_unreadable",
      file: waiversPath,
      message: (err as Error).message,
    })
    return []
  }
}

/**
 * Load the Journey Registry, recording any failure as a problem. The loader
 * throws on the first bad file — lint owns the per-problem detail; coverage
 * just refuses a broken registry.
 */
async function loadJourneyRegistry(
  dir: string,
  problems: CoverageProblem[],
): Promise<Journey[]> {
  try {
    return await loadJourneys(dir)
  } catch (err) {
    if (err instanceof JourneyLoadError) {
      problems.push({
        code: err.errors.length > 0 ? "journey_invalid" : "registry_unreadable",
        file: err.file,
        message: err.message,
      })
    } else {
      problems.push({
        code: "registry_unreadable",
        file: dir,
        message: (err as Error).message,
      })
    }
    return []
  }
}

/** The domain cell keys an expect maps to, given the journey's act surfaces. */
function candidateCellKeys(
  expect: Journey["expects"][number],
  hasChat: boolean,
  hasStaffHttp: boolean,
): string[] {
  const candidates: string[] = []
  if (hasChat) {
    candidates.push(coverageCellKey("chat", expect.intentKind, expect.decision))
  }
  if (hasStaffHttp) {
    candidates.push(coverageCellKey("staff-http", expect.intentKind, expect.decision))
  }
  return candidates
}

/**
 * How a journey claims a cell: `counted` journeys cover it; `quarantined`
 * journeys stay visible; `ignored` (blocked, non-quarantined) journeys
 * contribute nothing.
 */
type CellClaimRole = "counted" | "quarantined" | "ignored"

/** Record one journey's claim on a cell, per its {@link CellClaimRole}. */
function recordCellClaim(
  cell: CoverageCell,
  journeyId: string,
  role: CellClaimRole,
): void {
  if (role === "counted") {
    if (!cell.coveredBy.includes(journeyId)) cell.coveredBy.push(journeyId)
  } else if (role === "quarantined") {
    if (!cell.quarantinedBy.includes(journeyId)) cell.quarantinedBy.push(journeyId)
  }
}

/** Map a single journey's expects onto domain cells, mutating claimed cells in place. */
function processJourney(
  journey: Journey,
  quarantinedIds: ReadonlySet<string>,
  byKey: ReadonlyMap<string, CoverageCell>,
): JourneyPassEntry {
  const quarantined = quarantinedIds.has(journey.id)
  const counted = journey.status === "active" && !quarantined
  const hasChat = journey.acts.some((a) => a.kind === "chat")
  const hasStaffHttp = journey.acts.some(
    (a) => a.kind === "http" && a.asRole === "staff",
  )
  let claimRole: CellClaimRole = "ignored"
  if (counted) claimRole = "counted"
  else if (quarantined) claimRole = "quarantined"

  const claimedCells: string[] = []
  const unmatchedExpects: JourneyPassEntry["unmatchedExpects"] = []
  for (const expect of journey.expects) {
    // `optional: true` entries are reconciliation ALLOWANCES (T1b-1) — the
    // run tolerates them absent, so they may never claim a cell covered.
    if (expect.optional === true) continue
    let matched = false
    for (const key of candidateCellKeys(expect, hasChat, hasStaffHttp)) {
      const cell = byKey.get(key)
      if (cell === undefined) continue
      matched = true
      claimedCells.push(key)
      recordCellClaim(cell, journey.id, claimRole)
    }
    if (!matched) {
      unmatchedExpects.push({
        intentKind: expect.intentKind,
        decision: expect.decision,
      })
    }
  }

  return {
    id: journey.id,
    status: journey.status,
    quarantined,
    counted,
    verifyOnly: journey.expects.length === 0,
    claimedCells,
    unmatchedExpects,
  }
}

/** Assign a single cell's final state: covered ▸ waived-quarantined ▸ file waiver ▸ uncovered. */
function applyCellState(cell: CoverageCell, waiver: CoverageWaiver | undefined): void {
  if (cell.coveredBy.length > 0) {
    cell.state = "covered"
  } else if (cell.quarantinedBy.length > 0) {
    cell.state = "waived-quarantined"
    cell.waiver = {
      category: "waived-quarantined",
      reason: `quarantined journeys: ${cell.quarantinedBy.join(", ")}`,
      addedAt: null,
    }
  } else if (waiver !== undefined) {
    cell.state = waiver.category
    cell.waiver = {
      category: waiver.category,
      reason: waiver.reason,
      addedAt: waiver.addedAt,
    }
  }
}

/** Resolve every cell's state and return the waivers that matched no domain cell. */
function assignCellStates(
  cells: ReadonlyArray<CoverageCell>,
  waivers: ReadonlyArray<CoverageWaiver>,
): CoverageWaiver[] {
  const matchedWaivers = new Set<CoverageWaiver>()
  for (const cell of cells) {
    const waiver = waivers.find(
      (w) =>
        w.kind === cell.kind &&
        (w.decision === undefined || w.decision === "*" || w.decision === cell.decision),
    )
    if (waiver !== undefined) matchedWaivers.add(waiver)
    applyCellState(cell, waiver)
  }
  return waivers.filter((w) => !matchedWaivers.has(w))
}

/** Tally cell states into the report totals. */
function computeCoverageTotals(cells: ReadonlyArray<CoverageCell>): CoverageTotals {
  const totals: CoverageTotals = {
    cells: cells.length,
    covered: 0,
    uncovered: 0,
    "waived-pending-WS4": 0,
    "waived-unadvertised": 0,
    "waived-quarantined": 0,
  }
  for (const cell of cells) totals[cell.state] += 1
  return totals
}

/**
 * Compute the coverage report over the Journey Registry. Never throws on
 * content — registry/waiver failures land in `report.problems` (and a
 * report with problems is NOT a trustworthy matrix: `ok: false`).
 */
export async function computeJourneyCoverage(
  options?: ComputeCoverageOptions,
): Promise<JourneyCoverageReport> {
  const problems: CoverageProblem[] = []
  const quarantinedIds = new Set(options?.quarantined ?? [])

  // 1. Waivers.
  const waiversPath = options?.waiversPath ?? DEFAULT_COVERAGE_WAIVERS_PATH
  const waivers = await loadCoverageWaivers(waiversPath, problems)

  // 2. Journeys.
  const journeyList = await loadJourneyRegistry(
    options?.dir ?? DEFAULT_JOURNEYS_DIR,
    problems,
  )

  // 3. Domain matrix + claim mapping.
  const cells = buildCells()
  const byKey = new Map(cells.map((c) => [c.key, c]))
  const journeys = journeyList.map((journey) =>
    processJourney(journey, quarantinedIds, byKey),
  )

  // 4. State assignment + 5. totals.
  const dormantWaivers = assignCellStates(cells, waivers)
  const totals = computeCoverageTotals(cells)

  return {
    ok: problems.length === 0,
    totals,
    cells,
    journeys,
    dormantWaivers,
    problems,
  }
}

// ── Two views (coverage-matrix.json + journey-pass) ──────────────────────────

/** The `coverage-matrix.json` payload — the cell-level view. */
export function coverageMatrixView(report: JourneyCoverageReport): {
  totals: CoverageTotals
  cells: CoverageCell[]
  dormantWaivers: CoverageWaiver[]
} {
  return {
    totals: report.totals,
    cells: report.cells,
    dormantWaivers: report.dormantWaivers,
  }
}

/**
 * The journey-pass view — per-journey status summary. Exists alongside the
 * matrix because read-only acts produce no envelopes: a verify-only journey
 * is invisible in the cell matrix but first-class here.
 */
export function journeyPassView(report: JourneyCoverageReport): {
  journeys: JourneyPassEntry[]
} {
  return { journeys: report.journeys }
}

// ── Baseline (covered→uncovered regression gate) ─────────────────────────────

export interface CoverageBaseline {
  /** Cell keys (`<surface>:<kind>:<decision>`) the baseline claims covered. */
  covered: string[]
}

export const CoverageBaselineSchema = z
  .object({ covered: z.array(z.string()) })
  .strict()

/**
 * Explicit string comparator (S2871) that reproduces the default
 * `Array.prototype.sort()` UTF-16 code-unit order over the stable cell keys.
 */
function byStringOrder(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Capture the current covered cells as a baseline (sorted, stable). */
export function coverageBaseline(report: JourneyCoverageReport): CoverageBaseline {
  return {
    covered: report.cells
      .filter((c) => c.state === "covered")
      .map((c) => c.key)
      .sort(byStringOrder),
  }
}

export interface CoverageRegression {
  cell: string
  /** Current state of the baseline-claimed cell (`absent` = left the domain). */
  state: CoverageCellState | "absent"
}

export interface CoverageBaselineResult {
  ok: boolean
  /** Baseline-claimed cells no longer covered (and not quarantined) — FAIL. */
  regressions: CoverageRegression[]
  /**
   * Baseline-claimed cells now `waived-quarantined` — visible, NOT failing
   * (the Phase-1b flake ledger owns quarantine resolution).
   */
  quarantinedClaims: string[]
  /** Covered cells the baseline does not claim yet — reported, never failed. */
  newlyCovered: string[]
}

/**
 * Compare the current report against a committed baseline. A baseline-
 * claimed cell that is now uncovered/waived/absent is a regression (exit
 * nonzero in the CLI); `waived-quarantined` claims are surfaced but pass.
 */
export function verifyCoverageBaseline(
  report: JourneyCoverageReport,
  baseline: CoverageBaseline,
): CoverageBaselineResult {
  const byKey = new Map(report.cells.map((c) => [c.key, c]))
  const regressions: CoverageRegression[] = []
  const quarantinedClaims: string[] = []
  const claimed = new Set(baseline.covered)

  for (const key of baseline.covered) {
    const cell = byKey.get(key)
    if (cell === undefined) {
      regressions.push({ cell: key, state: "absent" })
    } else if (cell.state === "waived-quarantined") {
      quarantinedClaims.push(key)
    } else if (cell.state !== "covered") {
      regressions.push({ cell: key, state: cell.state })
    }
  }

  const newlyCovered = report.cells
    .filter((c) => c.state === "covered" && !claimed.has(c.key))
    .map((c) => c.key)
    .sort(byStringOrder)

  return { ok: regressions.length === 0, regressions, quarantinedClaims, newlyCovered }
}
