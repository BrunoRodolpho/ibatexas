// extraction/ barrel — the per-capability extraction-corpus infra (FE-T06, FE-2.1/FE-2.2).

export {
  ExpectPayloadSchema,
  ExtractionCaseSchema,
  ExtractionCorpusFileSchema,
  FieldTrustSchema,
  FIELD_TRUST_VALUES,
  IrExpectationSchema,
  validateExtractionCorpus,
  type ExpectPayload,
  type ExtractionCase,
  type ExtractionCorpusFile,
  type ExtractionCorpusValidation,
  type ExtractionSchemaError,
  type ExtractionSchemaErrorCode,
  type FieldTrust,
  type IrExpectation,
} from "./schema.js"

export {
  DEFAULT_EXTRACTION_CORPUS_DIR,
  ExtractionCorpusLoadError,
  loadExtractionCorpus,
  parseExtractionCorpusYaml,
} from "./load.js"

export {
  compileExpectPayload,
  evaluateExpectPayload,
  type EvaluateExpectPayloadOptions,
  type ExpectPayloadEvaluation,
  type ExpectPayloadRecordLike,
} from "./expect-payload.js"

export {
  ACCURACY_WAIVER_CATEGORIES,
  AccuracyBaselineSchema,
  AccuracyWaiversFileSchema,
  DEFAULT_ACCURACY_WAIVERS_PATH,
  accuracyBaseline,
  accuracyCaseKey,
  computeAccuracyReport,
  verifyAccuracyBaseline,
  type AccuracyBaseline,
  type AccuracyBaselineResult,
  type AccuracyCase,
  type AccuracyCaseResult,
  type AccuracyCaseState,
  type AccuracyProblem,
  type AccuracyProblemCode,
  type AccuracyRegression,
  type AccuracyReport,
  type AccuracyWaiver,
  type AccuracyWaiverCategory,
  type CapabilityAccuracy,
  type ComputeAccuracyReportOptions,
  type IsolationFailure,
} from "./accuracy.js"

export {
  AccuracyRunnerError,
  driveExtractionCorpusOverOpsChat,
  type DriveExtractionCorpusOptions,
  type DriveExtractionCorpusResult,
} from "./accuracy-runner.js"

export {
  ACCURACY_RUN_STAFF_PHONE,
  ExtractionAccuracyCliError,
  runExtractionAccuracyCli,
  type ExtractionAccuracyCliResult,
  type RunExtractionAccuracyCliOptions,
} from "./accuracy-cli.js"

// ── LE2-05 — the OFFLINE eval harness (the THIRD AccuracyCaseResult producer) ──

export {
  EVAL_ARTIFACT_SOURCES,
  EVAL_REFUSAL_CAPABILITY,
  EVAL_REFUSAL_CAPABILITY_IS_WAIVABLE,
  EvalArtifactSourceSchema,
  EvalFixtureFileSchema,
  RefusalCaseSchema,
  RefusalCorpusFileSchema,
  validateEvalFixture,
  validateRefusalCorpus,
  type EvalArtifactSource,
  type EvalAuditGoldArtifact,
  type EvalFixtureFile,
  type EvalFixtureValidation,
  type EvalSchemaError,
  type EvalSchemaErrorCode,
  type EvalWireArtifact,
  type RefusalCase,
  type RefusalCorpusFile,
  type RefusalCorpusValidation,
} from "./eval-schema.js"

export {
  EVAL_UNSCOREABLE_REASONS,
  computeClassification,
  computeRefusalCategory,
  computeUnscoreableSummary,
  envelopeFromAuditGold,
  envelopeFromWire,
  normalizeStructuralValue,
  normalizeUtterance,
  parseWireCompletion,
  scoreEvalCase,
  structuralEquals,
  unscoreableReason,
  type EvalCase,
  type EvalCaseOutcome,
  type EvalClassRow,
  type EvalObservation,
  type EvalParseCase,
  type EvalRefusalCase,
  type EvalRefusalCategory,
  type EvalRefusalLeak,
  type EvalUnscoreableReason,
  type EvalUnscoreableRow,
  type EvalUnscoreableSummary,
  type ParsedEnvelope,
} from "./eval-score.js"

export {
  DEFAULT_EVAL_ASSET_DIR,
  DEFAULT_EVAL_FIXTURES_DIR,
  DEFAULT_REFUSAL_CORPUS_PATH,
  ExtractionEvalLoadError,
  buildEvalIntake,
  envelopesFromFixtures,
  evalCasesFromCorpus,
  evalCasesFromRefusalCorpus,
  indexEnvelopesByUtterance,
  loadEvalFixtures,
  loadRefusalCorpus,
  parseEvalFixtureJson,
  parseRefusalCorpusYaml,
  type BuildEvalIntakeOptions,
  type EvalIntake,
  type IndexedEnvelope,
  type LoadedEvalFixture,
} from "./eval-intake.js"

export {
  DEFAULT_EVAL_BASELINE_PATH,
  DEFAULT_EVAL_FLAKE_LEDGER_PATH,
  DEFAULT_EVAL_WAIVERS_PATH,
  runExtractionEvalCli,
  type EvalSourceCoverage,
  type EvalTotals,
  type ExtractionEvalCliResult,
  type ExtractionEvalReport,
  type RunExtractionEvalCliOptions,
} from "./eval-cli.js"

export {
  ExtractionSchemaBindingSchema,
  checkBaselineAgainstCorpus,
  checkSchemaBinding,
  checkSchemaBindingCompleteness,
  recomputeSchemaBinding,
  sha256Hex,
  type BaselineCorpusConsistencyResult,
  type ExtractionSchemaBinding,
  type ExtractionSchemaBindingEntry,
  type SchemaBindingCheckResult,
  type SchemaBindingCompletenessResult,
  type SchemaBindingDrift,
} from "./static-gate.js"
