// @ibatexas/llm-provider
// Hybrid State-Flow agent pipeline and utilities.

export { runAgent } from "./agent.js"
export { NonRetryableError } from "@ibatexas/types"
// `executeToolDirect` was removed in task 06 (M1) — see tool-registry.ts
// for the rationale. Production mutations route through `executeTool`
// (LLM-proposed) or `executeKernel` (deterministic).
export { TOOL_DEFINITIONS, executeTool } from "./tool-registry.js"
export type { ToolExecutionResult } from "./tool-registry.js"

// Backward compat: SYSTEM_PROMPT still available for any consumer that imports it
export { SYSTEM_PROMPT } from "./prompt-sections.js"

// New pipeline exports
export { routeMessage } from "./router.js"
export { synthesizePrompt, buildDeterministicFallback } from "./prompt-synthesizer.js"
export type { SupervisorModifiers } from "./prompt-synthesizer.js"
export { orderMachine, getStateString } from "./machine/order-machine.js"
export { executeKernel, createDefaultContext, isCheckoutState, withTimeout, withRetry } from "./kernel-executor.js"
export type { OrderEvent, OrderContext, SynthesizedPrompt, IllusionContext, DerivedFields, KernelOutput, PendingAction, SupervisorInput, SupervisorOutput, SupervisorMode, LatencyEnvelope, ToolIntent } from "./machine/types.js"
export { extractIllusionContext, computeDerivedFields, createLatencyEnvelope, TOOL_CLASSIFICATION } from "./machine/types.js"

// Layer 2: Orchestrator (public API for conversation processing)
export { runOrchestrator, getRemainingBudget } from "./orchestrator.js"

// Layer 3: Supervisor
export { evaluateSupervisor } from "./supervisor.js"

// LLM responder (internal, but exported for test access)
export { generateResponse, buildConfirmationFallback } from "./llm-responder.js"

// Validation layer
export { shouldBufferText, checkForbiddenPhrases, validateBufferedText } from "./validation-layer.js"
export { validateBufferedTextTyped, refuseValidationFailure, type ValidationOutcome } from "./validation-layer.js"

// Refusal taxonomy (Phase D)
export {
  refuseCartEmpty,
  refuseForbiddenPhrase,
  refuseGuestCheckoutBlocked,
  refuseInvalidPaymentMethod,
  refuseNoOrderToMutate,
  refuseNotAuthenticated,
  refuseOrderAlreadyCancelled,
  refuseOrderAlreadyShipped,
  refuseQuantityOverLimit,
  refuseSlotsIncomplete,
  refuseUpsellExhausted,
  refuseDefaultDeny,
  GUARD_REFUSAL_MAP,
} from "./refusal-taxonomy.js"

// Guards (re-exported so adopter packages can wire PolicyBundles)
export {
  isAuthenticated,
  isWhatsApp,
  isNewCustomer,
  canCheckout,
  isCartEmpty,
  hasCartItems,
  allSlotsFilled,
  hasFulfillment,
  hasPaymentMethod,
  isValidPayment,
  shouldUpsell,
  computeCartFlags,
  canCancelOrder,
  canAmendOrder,
  hasOrderId,
  isPickup,
  isDelivery,
} from "./machine/guards.js"

// Capability planner (Phase I)
export {
  STATE_TOOLS,
  resolveTools,
  allowedIntentsFor,
  getForbiddenConceptsFor,
  orderCapabilityPlanner,
} from "./capability-planner.js"

// Order PolicyBundle (Phase B + Phase M)
//
// PIX-pending DEFER constants (signal, timeout, settled-status set)
// now live in @adjudicate/pack-payments-pix. Consumers must import
// directly from there; no re-export shim is provided.
export {
  orderPolicyBundle,
  orderTaintPolicy,
  type OrderEnvelope,
  type OrderState,
} from "./order-policy-bundle.js"

// Ledger error type (P0-g)
export { LedgerUnavailableError } from "./intent-ledger.js"

// Audit sink (Phase H) — needed by subscribers that emit audit records
// outside the responder hot path (e.g. defer-resolver on resume).
export {
  getAuditSink,
  // W3 — hook injectors for the 4 audit-pipeline ghost metrics. apps/api
  // wires these during `installKernelMetricsSink` so the redactor /
  // buffered-sink / spill emit Prometheus mutations.
  setAuditLagHook,
  setAuditRedactorFailureHook,
  setAuditSinkBufferSizeHook,
  setAuditSinkFailureHook,
  setAuditSinkSpillSizeHook,
  type AuditSinkFailureEventLike,
  // Internal-only — exported for cross-package integration tests that
  // need to inject failing Postgres writers / Redis stubs. Don't call
  // these from production code paths.
  _resetAuditSink,
  _setAuditSinkDependencies,
  _getAuditRedactor,
} from "./intent-audit-wiring.js"

// Audit Postgres writer adapter (task 19 / M4). Exposed so the NATS audit
// archiver subscriber (`apps/api/src/subscribers/audit-consumer.ts`) can
// build its own `PostgresWriter` against the same SQL contract the in-
// process sink uses. Keeps the INSERT shape in one place.
export {
  createPostgresAuditWriter,
  type PrismaRawExecutor,
  type CreatePostgresAuditWriterOptions,
} from "./postgres-audit-writer.js"

// Redis spill storage (task 19 / M4). Exposed for ops tooling that wants
// to surface `getRedisSpillSize` on a /health route.
export {
  createRedisSpillStorage,
  getRedisSpillSize,
  type RedisListClient,
  type RedisSpillStorageOptions,
} from "./redis-spill-storage.js"

// Audit redactor (task 18 / M4). Exposed so future Packs or operator tools
// can construct a custom redactor (e.g. for replay-with-extra-rules) without
// reaching into the internal module path.
export {
  createAuditRedactor,
  type AuditRedactor,
  type AuditRedactorOptions,
} from "./audit-redactor.js"

// NEW-P1-ENV — strict-yet-tolerant boolean env-var parser. Replaces
// the unsafe `process.env.X === "true"` pattern across the codebase.
// Accepts true/1/yes/on (any case, trimmed); falls back to caller's
// defaultValue for empty/undefined/typo inputs.
export { parseBoolEnv } from "./parse-bool-env.js"

// Re-export agent types for consumers
export type { AgentContext, AgentMessage, StreamChunk } from "@ibatexas/types"

// Logger shim (W6-10 / P2-C) — apps/api can pass `req.log` for reqId
// correlation. Default passthrough preserves dev console-log behaviour.
export { defaultLogger, resolveLogger, type IbxLogger } from "./logger.js"

// Intent-kind union (Phase M / task-08 follow-up) — consumed by
// `validateEnforceConfig` from `@adjudicate/core/kernel` so typos in
// `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` surface at boot.
export { KNOWN_INTENT_KINDS } from "./intent-kinds.js"

// Intent dispatcher (task 02) — the post-adjudication EXECUTE consumer.
// Re-exported here so apps/api can compose the resume-path adapter
// (`createResumeDispatcherAdapter`) without reaching into module-internal
// paths.
export {
  createIntentDispatcher,
  createDefaultDispatchHandlers,
  DETERMINISTIC_KERNEL_COVERAGE,
  type DispatchResult,
  type DispatchHandler,
  type IntentDispatcher,
  type DispatcherDeps,
  type DispatcherLogger,
} from "./intent-dispatcher.js"

// P0-7-TRUE / audit-2026-05-24 P0-1 — NX-guarded DEFER park wrapper.
// All four production DEFER call sites (kernel-executor, llm-responder,
// me.ts ×2) route through this single entry point to prevent the silent
// overwrite that the framework's raw `parkDeferredIntent` admits.
export {
  parkDeferredIntentWithNxGuard,
  setDeferQuotaExceededHook,
  ParkVerificationFieldsMissingError,
  PARK_COLLISION_REFUSAL_PT_BR,
  type ParkDeferredIntentNxResult,
} from "./park-nx.js"
