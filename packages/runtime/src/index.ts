// @adjudicate/runtime — runtime-side framework helpers.
//
// Two concerns live here:
//
//  1. Deferred intent resume (defer-resume.ts) — when the kernel returns
//     DEFER for a valid-but-pending intent, this package handles the
//     resume half with content-addressed dedup so duplicate webhook
//     deliveries fold into a single resume.
//
//  2. Deadline helpers (with-deadlines.ts) — small primitives for racing
//     async generators against a hard wall-clock deadline; useful for
//     orchestrators that wrap LLM streams.

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

export { DEADLINE_HIT, deadlinePromise } from "./with-deadlines.js"
