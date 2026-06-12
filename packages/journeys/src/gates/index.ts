// gates/ barrel — registry gates: lint (T1a-2) + coverage (T1a-3).

export {
  lintJourneys,
  lintJourney,
  lintDigestLock,
  verifyLintBaseline,
  journeyPersonaContext,
  advertisedChatKinds,
  STAFF_ROUTE_KINDS,
  type JourneyPersonaContext,
  type JourneyLintCode,
  type JourneyLintProblem,
  type JourneyLintEntry,
  type JourneyLintReport,
  type LintJourneysOptions,
  type LintBaselineMismatch,
} from "./lint.js"

export {
  computeJourneyCoverage,
  coverageMatrixView,
  journeyPassView,
  coverageBaseline,
  verifyCoverageBaseline,
  coverageCellKey,
  plausibleDecisions,
  WaiversFileSchema,
  CoverageBaselineSchema,
  WAIVER_CATEGORIES,
  DEFAULT_COVERAGE_WAIVERS_PATH,
  type WaiverCategory,
  type CoverageWaiver,
  type CoverageSurface,
  type CoverageCellState,
  type CoverageCell,
  type CoverageTotals,
  type CoverageProblem,
  type CoverageProblemCode,
  type JourneyPassEntry,
  type JourneyCoverageReport,
  type ComputeCoverageOptions,
  type CoverageBaseline,
  type CoverageRegression,
  type CoverageBaselineResult,
} from "./coverage.js"

export { KNOWN_INVARIANT_IDS } from "./invariant-registry.js"
