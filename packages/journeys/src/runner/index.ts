// runner/ barrel — sequential journey runner skeleton (owned by T1a-1)
// + per-run journey locks (T1b-7).

export {
  runJourney,
  JourneyBlockedError,
  type ActExecutors,
  type ActExecutor,
  type ActExecutionResult,
  type ActOutcome,
  type ActRunRecord,
  type JourneyRunContext,
  type JourneyRunResult,
  type RunJourneyOptions,
} from "./run-journey.js"

export {
  acquireJourneyLock,
  JourneyLockTimeoutError,
  JOURNEY_LOCK_TTL_SECONDS,
  JOURNEY_LOCK_ACQUIRE_TIMEOUT_MS,
  type JourneyLockHandle,
  type JourneyLockOptions,
  type JourneyLockRedis,
} from "./journey-lock.js"
