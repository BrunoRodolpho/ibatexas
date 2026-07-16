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
