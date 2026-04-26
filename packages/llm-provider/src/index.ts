// @ibatexas/llm-provider
// Hybrid State-Flow agent pipeline and utilities.

export { runAgent } from "./agent.js"
export { NonRetryableError } from "@ibatexas/types"
export { TOOL_DEFINITIONS, executeTool, executeToolDirect } from "./tool-registry.js"
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
export {
  orderPolicyBundle,
  orderTaintPolicy,
  PIX_CONFIRMATION_SIGNAL,
  PIX_CONFIRMED_STATUSES,
  PIX_DEFER_TIMEOUT_MS,
  type OrderEnvelope,
  type OrderState,
} from "./order-policy-bundle.js"

// Ledger error type (P0-g)
export { LedgerUnavailableError } from "./intent-ledger.js"

// Re-export agent types for consumers
export type { AgentContext, AgentMessage, StreamChunk } from "@ibatexas/types"
