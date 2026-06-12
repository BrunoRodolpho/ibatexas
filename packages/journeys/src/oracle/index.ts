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
