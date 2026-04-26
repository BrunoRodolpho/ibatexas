// @adjudicate/intent-runtime — the IBX-IGE runtime entrypoint.
//
// apps/api depends on this package's `runOrchestrator()` as the sole public
// surface. Subpath exports (/engine, /adapters/xstate, /policies/order) are
// organized for the v2.0 package split so that move is a rename, not a
// redesign.

export { runOrchestrator, getRemainingBudget } from "./engine/orchestrator.js"
export {
  executeKernel,
  createDefaultContext,
  isCheckoutState,
} from "./engine/kernel-executor.js"
export {
  orderPolicyBundle,
  orderTaintPolicy,
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFER_TIMEOUT_MS,
  type OrderEnvelope,
  type OrderState,
} from "./policies/order-policies.js"
export {
  deferResumeHash,
  resumeDeferredIntent,
  DEFER_PENDING_TTL_GRACE_SECONDS,
  PIX_CONFIRMED_STATUSES,
  type DeferRedis,
  type DeferLogger,
  type DeferResumeResult,
  type ParkedEnvelope,
  type ResumeDeferredIntentArgs,
} from "./defer-resume.js"
