// gates/ barrel — registry gates: lint (T1a-2); coverage joins here (T1a-3).

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

export { KNOWN_INVARIANT_IDS } from "./invariant-registry.js"
