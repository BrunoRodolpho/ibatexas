// driver/ barrel — LLM test-driver agent (T1a-8).
//
// Anthropic tool-use loop with the CLOSED act-tool set {chat, http} —
// see persona-driver.ts for the closed-set + grep-gate governance header.
// Emits `llm.call` (the dollar source), `evidence.capture`, and
// `journey.aborted` reason=token_ceiling through @ibatexas/tools.

export {
  PersonaDriver,
  createDriverChatExecutor,
  DriverTokenCeilingError,
  DRIVER_ACT_TOOL_NAMES,
  DRIVER_MODEL_ENV,
  DEFAULT_DRIVER_MODEL,
  DEFAULT_MAX_TURNS_PER_ACT,
  DEFAULT_TOKEN_CEILING,
  DEFAULT_MAX_TOKENS_PER_CALL,
  type DriverActToolName,
  type DriverChatTurnFn,
  type DriverHttpExecutor,
  type DriverHttpResult,
  type DriverMetadata,
  type PersonaDriverOptions,
} from "./persona-driver.js"

export {
  createAnthropicModelProvider,
  type AnthropicModelProviderOptions,
} from "./anthropic-provider.js"

export type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelTextBlock,
  ModelToolDefinition,
  ModelToolResult,
  ModelToolUseBlock,
  ModelUsage,
} from "./model-provider.js"
