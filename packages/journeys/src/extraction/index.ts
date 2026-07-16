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
  type ExpectPayloadEvaluation,
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
