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

// Audit sink (Phase H + audit-2026-05-24 H2 A1 cutover) — needed by
// subscribers that emit audit records outside the responder hot path
// (e.g. defer-resolver on resume) and by the kernel-bootstrap step that
// wires the boot-time DI of the leaf `@ibatexas/audit-sink` package.
// claustrum-on-dev WS1: the audit/observability INFRASTRUCTURE relocated to
// the leaf `@ibatexas/audit-sink` package (so it survives this package's
// deletion). These are RE-EXPORTS from the new home — existing importers
// that still `import { ... } from "@ibatexas/llm-provider"` keep working
// mid-migration. New code should import directly from `@ibatexas/audit-sink`.
export {
  // Sink construction + boot-time DI (defined in the leaf's index.ts).
  getAuditSink,
  AuditSinkNotInitializedError,
  // The audit-sink-bootstrap step in apps/api uses this to construct the
  // leaf's `AuditSinkDependencies` shape from the live Redis / Prisma /
  // NATS clients.
  buildAuditSinkDependencies,
  type AuditSinkLiveDependencies,
  // W3 — hook injectors for the 4 audit-pipeline ghost metrics. apps/api
  // wires these during `installKernelMetricsSink` so the redactor /
  // buffered-sink / spill emit Prometheus mutations.
  setAuditLagHook,
  setAuditRedactorFailureHook,
  setAuditSinkBufferSizeHook,
  setAuditSinkFailureHook,
  setAuditSinkSpillSizeHook,
  // audit-2026-05-24 P1-4 — track ON CONFLICT DO NOTHING events so ops
  // can see when the in-process sink and the audit-consumer redundancy
  // path collide on the same row (the desired steady-state once the
  // upstream UNIQUE constraint lands in `@adjudicate/audit-postgres`).
  setAuditDedupHook,
  type AuditSinkFailureEventLike,
  // Internal-only — exported for cross-package integration tests that
  // need to inject failing Postgres writers / Redis stubs. Don't call
  // these from production code paths.
  _resetAuditSink,
  _setAuditSinkDependencies,
  _getAuditRedactor,
  type LegacyAuditSinkDependencyOverride,
  // Audit Postgres writer adapter (task 19 / M4) — the NATS audit archiver
  // subscriber builds its own `PostgresWriter` against the same SQL contract.
  createPostgresAuditWriter,
  type PrismaRawExecutor,
  type CreatePostgresAuditWriterOptions,
  // Redis spill storage (task 19 / M4) — `getRedisSpillSize` for /health.
  createRedisSpillStorage,
  getRedisSpillSize,
  type RedisListClient,
  type RedisSpillStorageOptions,
  // Audit redactor (task 18 / M4) — the PII gate. INTENT_KIND_FIELD_RULES +
  // PII_FREE_KIND_ALLOWLIST feed the per-intent-kind conformance suite.
  createAuditRedactor,
  INTENT_KIND_FIELD_RULES,
  PII_FREE_KIND_ALLOWLIST,
  type AuditRedactor,
  type AuditRedactorOptions,
} from "@ibatexas/audit-sink"

// NEW-P1-ENV — strict-yet-tolerant boolean env-var parser. Relocated to
// `@ibatexas/types` (claustrum-on-dev WS1); re-exported here for existing
// importers. Replaces the unsafe `process.env.X === "true"` pattern.
export { parseBoolEnv } from "@ibatexas/types"

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

// Resume-side kernel dispatcher — audit-2026-05-24 P1-3.
// Re-exported so `apps/api/src/adapters/resume-dispatcher.ts` can invoke the
// kernel-covered mutations on the resume path (the intent-dispatcher returns
// `kind: "skipped"` for those because the responder hot path runs them via
// the XState machine; resume has no machine, hence this seam).
export {
  dispatchResumedKernelEnvelope,
  type ResumeKernelDispatchResult,
  type ResumeKernelDispatchDeps,
} from "./resume-kernel-dispatcher.js"

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
