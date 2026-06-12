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
