// harness/ barrel — environment handshake + invariant harness.
//
// T1a-10: pre-flight (IBX_TEST_FINGERPRINT handshake via /health
// testFingerprint, hostname denylist over the infraEndpoints() address
// source, ANTHROPIC_MODEL == certification target with the nonCertifying
// escape, ANTHROPIC_API_KEY presence). Later agents extend ONLY this
// barrel — the root src/index.ts already re-exports it.

export {
  CERTIFICATION_MODEL,
  NON_CERTIFYING_ENV,
  PREFLIGHT_CHECKS,
  PreflightRefusalError,
  runPreflight,
  TEST_FINGERPRINT_ENV,
  type FetchLike,
  type PreflightCheckName,
  type PreflightCheckRecord,
  type PreflightOptions,
  type PreflightResult,
} from "./preflight.js"

// T1a-13 — `ibx journey run`: full live loop with measured cost.
export {
  ATTEMPT_TIMEOUT_MS,
  JourneyRunCliError,
  runJourneyCli,
  type JourneyAttemptReport,
  type JourneyRunReport,
  type RunJourneyCliOptions,
  type TokenSplitReport,
} from "./run-journey-cli.js"
export { loadTestEnv, parseEnvFile, type LoadTestEnvResult } from "./test-env.js"
export {
  attemptCost,
  costOfCalls,
  DEFAULT_PRICE_TABLE_PATH,
  formatUsd,
  loadPriceTable,
  PriceTableError,
  readSutLlmCalls,
  renderCostLine,
  type AttemptCost,
  type CostSide,
  type LlmCallLike,
  type ModelPrice,
  type PriceTable,
  type TokenSplit,
} from "./cost.js"
