// @adjudicate/intent-runtime — DEFER consumer + idempotent resume.
//
// Pure resume logic for parked deferred intents. The kernel returns DEFER
// for valid intents that await an external signal (e.g. a payment webhook
// confirming a parked order). resumeDeferredIntent uses content-addressed
// dedup so duplicate webhook deliveries fold into a single resume.
//
// Adopters wire their own NATS / queue subscriber and Redis client; the
// framework keeps no transport coupling.

export {
  deferResumeHash,
  resumeDeferredIntent,
  DEFER_PENDING_TTL_GRACE_SECONDS,
  type DeferRedis,
  type DeferLogger,
  type DeferResumeResult,
  type ParkedEnvelope,
  type ResumeDeferredIntentArgs,
} from "./defer-resume.js"
