// oracle/ barrel — deterministic oracle kit.
//
// T1a-6 (ProjectionBarrier) below; T1a-7 (AuditReader + AuditTrailMatcher)
// adds its exports here. Later agents edit ONLY this barrel —
// the root src/index.ts already re-exports it.

export {
  awaitProjection,
  eventSeen,
  findEvents,
  hasEvent,
  isAnonymizedEventPayload,
  ProjectionBarrierTimeoutError,
  type AwaitProjectionOptions,
  type AwaitProjectionResult,
  type EventMatch,
  type OrderEventLogRow,
  type OrderProjectionRow,
  type ProjectionBarrierPrisma,
  type ProjectionBarrierState,
  type ProjectionPredicate,
} from "./projection-barrier.js"

// T1a-7 — AuditReader (read-only intent_audit reader, run-sessionId scoped).
export {
  AuditReaderScopeError,
  createAuditReader,
  RUN_SESSION_NAMESPACE,
  runNamespacePrefix,
  verifyFetchedRecords,
  type AuditReader,
  type AuditVerificationFailure,
  type AuditVerificationReport,
  type CreateAuditReaderOptions,
  type FetchAuditRecordsOptions,
  type OracleQueryable,
  type RunSessionScope,
  type VerifyFetchedRecordsOptions,
} from "./audit-reader.js"

// T1a-7 — AuditTrailMatcher (EXACT / IN_ORDER / ANY_ORDER trajectories,
// supersession chains resolved via the upstream @adjudicate/audit walker).
export {
  matchTrajectory,
  resolveSupersessionChains,
  type ExpectedTrajectoryStep,
  type MatchTrajectoryOptions,
  type ObservedTrajectoryStep,
  type PayloadPredicate,
  type ResolvedTrajectory,
  type TrajectoryMatchResult,
  type TrajectoryMismatchReason,
  type TrajectoryMode,
  type TrajectoryStepMismatch,
} from "./audit-trail-matcher.js"

// T1a-9 — test-plane containment wiring.
export {
  createHttpVerifyClient,
  HttpVerifyMethodError,
  HttpVerifyOriginError,
  type HttpVerifyClient,
  type HttpVerifyClientOptions,
  type HttpVerifyFetch,
  type HttpVerifyGetInit,
  type HttpVerifyResponse,
} from "./http-verify-client.js"
export {
  ORACLE_DB_ROLE,
  OracleDatabaseUrlError,
  requireOracleDatabaseUrl,
} from "./oracle-database-url.js"

// T1a-13 — read-only domain lookups + the audit-namespace hash (run scoping).
export {
  createDomainReader,
  hashedAuditSessionId,
  projectionBarrierPrisma,
  type CreateDomainReaderOptions,
  type DomainCustomerRow,
  type DomainOrderProjectionRow,
  type DomainReader,
} from "./domain-reader.js"
