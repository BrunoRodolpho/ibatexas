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
  abortedByBudgetAttemptReport,
  ATTEMPT_TIMEOUT_MS,
  JourneyRunCliError,
  runAttemptsWithBudget,
  runJourneyCli,
  type JourneyAttemptReport,
  type JourneyRunReport,
  type RunJourneyCliOptions,
  type TokenSplitReport,
} from "./run-journey-cli.js"

// T1b-8 — suite-level dollar abort + `ibx journey run --suite`.
export {
  ABORTED_BY_BUDGET,
  BudgetConfigError,
  createDollarBudget,
  DEFAULT_NIGHTLY_BUDGET_USD,
  DollarBudget,
  NIGHTLY_BUDGET_ENV,
  renderBudgetLine,
  resolveBudgetCapUsd,
  type BudgetCapSource,
  type BudgetReport,
  type ResolvedBudgetCap,
  type RunCompletionStatus,
} from "./budget.js"
export {
  runJourneySuiteCli,
  type JourneySuiteReport,
  type RunJourneySuiteCliOptions,
} from "./run-suite-cli.js"
export { loadTestEnv, parseEnvFile, type LoadTestEnvResult } from "./test-env.js"

// T3-9 — the single allowlisted test-plane NATS publish: wake a managed agent
// by injecting its trigger event (fingerprint-gated — refuses without
// IBX_TEST_FINGERPRINT). Consumed by `ibx agent trigger` (CLI test plane) and
// managed-agent journeys; never by the persona driver (grep-gated).
export {
  injectPixFailureTrigger,
  TriggerInjectFingerprintRequiredError,
  type PixFailureTriggerOptions,
} from "./trigger-inject.js"

// T1b-4 — flake policy WITH OWNERSHIP (retry-once = yellow; quarantine after
// 2 consecutive flaky nights; manual green-twice de-quarantine) + the
// nightly mode of `ibx journey run --suite`.
export {
  DEFAULT_FLAKE_LEDGER_PATH,
  dequarantineJourney,
  emptyFlakeLedger,
  FLAKE_LEDGER_VERSION,
  FlakeLedgerError,
  FlakeLedgerSchema,
  flakeOwner,
  loadFlakeLedger,
  QUARANTINE_THRESHOLD,
  quarantinedJourneyIds,
  recordNightlyOutcome,
  saveFlakeLedger,
  type FlakeLedger,
  type FlakeLedgerEntry,
  type NightlyOutcome,
  type RecordOutcomeResult,
} from "./flake-ledger.js"
export {
  DEQUARANTINE_MANUAL_COMMANDS,
  runNightlySuiteCli,
  type NightlyIssuePayload,
  type NightlyJourneyOutcome,
  type NightlyLedgerReport,
  type NightlySuiteReport,
  type RunNightlySuiteCliOptions,
} from "./nightly-suite.js"

// T1b-5 — sim_runs / sim_results: persistent run records joined to the
// audit ledger via the run's HASHED sessionId namespaces (D-012).
export {
  buildSimResults,
  createSimStore,
  requireSimDatabaseUrl,
  SIM_DATABASE_URL_ENV,
  SIM_DB_ROLE,
  SIM_RUN_DECISIONS_SQL,
  SimDatabaseUrlError,
  type CreateSimStoreOptions,
  type SimQueryable,
  type SimResultRow,
  type SimRunRow,
  type SimStore,
} from "./sim-store.js"
export {
  migrateSimTables,
  SIM_MIGRATIONS_TABLE,
  simMigrationsDir,
  type SimMigrateClient,
  type SimMigrateResult,
} from "./sim-migrate.js"
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
