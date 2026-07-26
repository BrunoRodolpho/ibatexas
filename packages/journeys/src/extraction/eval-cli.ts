// extraction/eval-cli.ts — LE2-05: the `ibx journey extraction-eval`
// composition. Mirrors `accuracy-cli.ts`'s relationship to the CLI (thin
// registration in packages/cli, ALL composition here) and reuses
// `accuracy.ts`'s report/baseline/waiver machinery unchanged.
//
// Steps: load the pinned inputs (`eval-intake.ts`) -> score each eval case
// against the artifacts captured for its utterance (`eval-score.ts`) -> feed
// the resulting `AccuracyCaseResult[]` through the EXISTING
// `computeAccuracyReport` -> bolt on the three things the live meter has no
// notion of: the refusal/irrelevance category, the per-capability
// classification matrix, and the UNSCOREABLE roll-up.
//
// OFFLINE, always: no HTTP, no database, no model. Contrast
// `extraction-accuracy`, which drives the live model — this command never
// does. Its one and only failure mode is a bad committed file.
//
// DETERMINISM (LE2-05's AC): the scored body carries NO timestamp, no wall
// clock, no run id, no host detail — the existing `AccuracyReport` idiom
// (which has none either). Every collection is sorted (cases by their stable
// intake order, capability rows and leak rows by capability, unscoreable rows
// by the declared reason order, source rows by source). Running the command
// twice over the same committed files is byte-identical by construction.

import { fileURLToPath } from "node:url"
import {
  computeAccuracyReport,
  type AccuracyCaseResult,
  type AccuracyReport,
  type ComputeAccuracyReportOptions,
} from "./accuracy.js"
import { buildEvalIntake, type BuildEvalIntakeOptions, type EvalIntake } from "./eval-intake.js"
import { EVAL_ARTIFACT_SOURCES, type EvalArtifactSource } from "./eval-schema.js"
import {
  computeClassification,
  computeRefusalCategory,
  computeUnscoreableSummary,
  normalizeUtterance,
  scoreEvalCase,
  type EvalCaseOutcome,
  type EvalClassRow,
  type EvalObservation,
  type EvalRefusalCategory,
  type EvalUnscoreableSummary,
} from "./eval-score.js"

// No `ExtractionEvalCliError` exists on purpose. The live meter needs one
// (missing secrets, an unseeded identity, an unreachable SUT); an OFFLINE
// replay has exactly ONE failure mode — a bad committed file — and that
// already has precise, named errors: `ExtractionEvalLoadError` (eval-intake.ts)
// and `ExtractionCorpusLoadError` (load.ts). A third, empty error class would
// be an abstraction with no failure to carry.

/**
 * The eval harness's OWN baseline (binding path):
 * `packages/journeys/governance/extraction-eval-baseline.json`. SEPARATE from
 * the live meter's `extraction-accuracy-baseline.json` — the two measure
 * different things (a live drive vs. a replay of pinned artifacts) and must
 * never be mixed. Same `{passing: string[]}` shape, same no-tolerance
 * `verifyAccuracyBaseline` discipline.
 */
export const DEFAULT_EVAL_BASELINE_PATH = fileURLToPath(
  new URL("../../governance/extraction-eval-baseline.json", import.meta.url),
)

/**
 * The eval harness's OWN waivers file (binding path):
 * `packages/journeys/governance/extraction-eval-waivers.json`. Same schema
 * and semantics as the live meter's waivers; separate file for the same
 * reason the baseline is separate.
 */
export const DEFAULT_EVAL_WAIVERS_PATH = fileURLToPath(
  new URL("../../governance/extraction-eval-waivers.json", import.meta.url),
)

/**
 * The DISTINCT flake-ledger file the `--quarantined` seam reads from:
 * `packages/journeys/governance/extraction-eval-flake-ledger.json`, driven by
 * the EXISTING machinery (`ibx journey flake --ledger <path>
 * --list-quarantined`) exactly as `accuracy.ts` documents for the live meter.
 * No ledger code is reinvented here and — matching that precedent — no ledger
 * file is committed until something is actually quarantined: a replay of
 * pinned artifacts is deterministic, so it CANNOT flake. The seam exists for
 * the day an artifact set is knowingly unstable, not before.
 */
export const DEFAULT_EVAL_FLAKE_LEDGER_PATH = fileURLToPath(
  new URL("../../governance/extraction-eval-flake-ledger.json", import.meta.url),
)

// ── Report ──────────────────────────────────────────────────────────────────

export interface EvalSourceCoverage {
  source: EvalArtifactSource
  /** Committed fixture files declaring this source. */
  fixtures: number
  /** True when ANY of them is hand-authored rather than exported (labelled, never hidden). */
  synthetic: boolean
  /** Artifacts contributed. */
  artifacts: number
  /** Of those, the ones whose utterance matched at least one eval case. */
  matchedArtifacts: number
  /** Of those, the ones matching NO case (captured evidence nothing asks about). */
  orphanArtifacts: number
  /** Distinct eval cases this source supplied at least one artifact for. */
  casesCovered: number
}

export interface EvalTotals {
  cases: number
  passing: number
  failing: number
  unscoreable: number
  /** `cases - unscoreable` — the cases that actually had something to score. */
  scoreable: number
  /** `passing / scoreable` (0 when scoreable === 0) — the headline number. */
  ratio: number
}

export interface ExtractionEvalReport {
  /** False when the underlying `AccuracyReport` carries any problem. */
  ok: boolean
  /** The EXISTING pipeline's output — cases, per-capability rows, waivers, problems. */
  accuracy: AccuracyReport
  totals: EvalTotals
  /** First-class refusal/irrelevance category (never folded into pass/fail). */
  refusal: EvalRefusalCategory
  /** Per-capability precision/recall over the selected capability, ∅ class included. */
  classification: EvalClassRow[]
  unscoreable: EvalUnscoreableSummary
  sources: EvalSourceCoverage[]
}

function computeSourceCoverage(intake: EvalIntake, caseKeys: ReadonlySet<string>): EvalSourceCoverage[] {
  return EVAL_ARTIFACT_SOURCES.map((source) => {
    const fixtures = intake.fixtures.filter((f) => f.fixture.source === source)
    const indexed = intake.indexed.filter((i) => i.envelope.source === source)
    const matched = indexed.filter((i) => caseKeys.has(i.key))
    return {
      source,
      fixtures: fixtures.length,
      synthetic: fixtures.some((f) => f.fixture.synthetic),
      artifacts: indexed.length,
      matchedArtifacts: matched.length,
      orphanArtifacts: indexed.length - matched.length,
      casesCovered: new Set(matched.map((i) => i.key)).size,
    }
  })
}

export interface RunExtractionEvalCliOptions extends BuildEvalIntakeOptions {
  /** Waivers file override (default: the committed eval governance file). */
  waiversPath?: string
  /** Quarantined case keys (`<capability>:<caseId>`) — see the ledger doc above. */
  quarantined?: readonly string[]
  onProgress?: (line: string) => void
}

export interface ExtractionEvalCliResult {
  report: ExtractionEvalReport
  results: AccuracyCaseResult[]
  outcomes: EvalCaseOutcome[]
}

/**
 * The full offline run: load the pinned inputs, score, assemble. Callers
 * needing the baseline-regression VERDICT layer apply `verifyAccuracyBaseline`
 * to `report.accuracy` themselves (mirrors `runExtractionAccuracyCli`'s split
 * between the report and the CLI's own `--verify-file` handling).
 */
export async function runExtractionEvalCli(
  options: RunExtractionEvalCliOptions = {},
): Promise<ExtractionEvalCliResult> {
  const onProgress = options.onProgress ?? ((): void => undefined)

  const intakeOptions: BuildEvalIntakeOptions = {}
  if (options.corpusDir !== undefined) intakeOptions.corpusDir = options.corpusDir
  if (options.fixturesDir !== undefined) intakeOptions.fixturesDir = options.fixturesDir
  if (options.refusalCorpusPath !== undefined) {
    intakeOptions.refusalCorpusPath = options.refusalCorpusPath
  }

  const intake = await buildEvalIntake(intakeOptions)
  onProgress(
    `intake: ${intake.cases.length} eval case(s), ${intake.fixtures.length} fixture file(s), ` +
      `${intake.indexed.length} captured artifact(s)`,
  )

  const outcomes: EvalCaseOutcome[] = intake.cases.map((evalCase) =>
    scoreEvalCase(evalCase, intake.envelopesByUtterance.get(normalizeUtterance(evalCase.utterance)) ?? []),
  )
  const results = outcomes.map((o) => o.result)

  const computeOptions: ComputeAccuracyReportOptions = { results }
  computeOptions.waiversPath = options.waiversPath ?? DEFAULT_EVAL_WAIVERS_PATH
  if (options.quarantined !== undefined) computeOptions.quarantined = options.quarantined
  const accuracy = await computeAccuracyReport(computeOptions)

  const observations: EvalObservation[] = outcomes
    .filter((o) => o.result.unscoreable !== true)
    .flatMap((o) => o.observations)

  const passing = accuracy.cases.filter((c) => c.state === "passing").length
  const unscoreableCases = accuracy.cases.filter((c) => c.state === "unscoreable").length
  const scoreable = accuracy.cases.length - unscoreableCases

  const caseKeys = new Set(intake.cases.map((c) => normalizeUtterance(c.utterance)))

  const report: ExtractionEvalReport = {
    ok: accuracy.ok,
    accuracy,
    totals: {
      cases: accuracy.cases.length,
      passing,
      failing: accuracy.cases.filter((c) => c.state === "failing").length,
      unscoreable: unscoreableCases,
      scoreable,
      ratio: scoreable === 0 ? 0 : passing / scoreable,
    },
    refusal: computeRefusalCategory(outcomes),
    classification: computeClassification(observations),
    unscoreable: computeUnscoreableSummary(outcomes),
    sources: computeSourceCoverage(intake, caseKeys),
  }

  return { report, results, outcomes }
}
