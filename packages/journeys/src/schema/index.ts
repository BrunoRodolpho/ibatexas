// schema/ barrel — journey file schema v1 + YAML loader (owned by T1a-1).

export {
  JourneyFileSchema,
  ActSchema,
  ChatActSchema,
  HttpActSchema,
  FixtureActSchema,
  ExpectSchema,
  VerifySchema,
  JourneyStatusSchema,
  JourneyChannelSchema,
  JsonValueSchema,
  JOURNEY_ID_PATTERN,
  JOURNEY_EXPECT_DECISIONS,
  INTENT_KIND_PATTERN,
  RAW_MEDUSA_ID_PATTERN,
  validateJourney,
  type Journey,
  type JourneyAct,
  type ActKind,
  type ChatAct,
  type HttpAct,
  type FixtureAct,
  type JourneyExpect,
  type JourneyVerify,
  type JourneyStatus,
  type JsonValue,
  type JourneySchemaError,
  type JourneySchemaErrorCode,
  type JourneyValidation,
} from "./journey.js"

export {
  loadJourneys,
  parseJourneyYaml,
  JourneyLoadError,
  DEFAULT_JOURNEYS_DIR,
} from "./load.js"

// T2-3 — `ibx journey from-audit <sessionId>` scaffolder.
export {
  FromAuditScaffoldError,
  observedDecisionsFromRecords,
  scaffoldFromAuditSession,
  scaffoldJourneyFromAudit,
  SCAFFOLD_PLACEHOLDER_ID,
  SCAFFOLD_REVIEW_BLOCKER,
  transcriptFromChatDumpJson,
  type FromAuditScaffoldOptions,
  type FromAuditScaffoldResult,
  type ScaffoldedJourney,
  type ScaffoldJourneyInput,
  type ScaffoldObservedDecision,
  type ScaffoldTranscript,
  type ScaffoldTranscriptMessage,
} from "./scaffold.js"
