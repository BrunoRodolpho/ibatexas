// driver/model-provider.ts — neutral ModelProvider port for the test driver.
//
// The persona driver (persona-driver.ts) talks to the LLM through THIS
// narrow port, never through the Anthropic SDK directly. Two reasons:
//
//   1. Offline tests (T1a-8 acceptance): a scripted stub implementing
//      `ModelProvider` drives the full tool-use loop with deterministic
//      canned responses — zero tokens, zero network.
//   2. The dollar source: the driver emits one `llm.call` event per
//      `complete()` round-trip with the usage THIS port reports, so the
//      port shape forces token accounting to exist.
//
// The real implementation is `createAnthropicModelProvider`
// (anthropic-provider.ts), a thin adapter over @anthropic-ai/sdk.

// ── Content blocks ───────────────────────────────────────────────────────────

export interface ModelTextBlock {
  type: "text"
  text: string
}

export interface ModelToolUseBlock {
  type: "tool_use"
  /** Provider-assigned id — echoed back on the matching tool_result. */
  id: string
  name: string
  input: Record<string, unknown>
}

export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock

/** Result of one executed act tool, fed back to the model. */
export interface ModelToolResult {
  type: "tool_result"
  toolUseId: string
  content: string
  isError?: boolean
}

// ── Messages / tools / request / response ────────────────────────────────────

export type ModelMessage =
  | { role: "user"; content: string | ModelToolResult[] }
  | { role: "assistant"; content: ModelContentBlock[] }

export interface ModelToolDefinition {
  name: string
  description: string
  /** JSON schema for the tool input (object root). */
  inputSchema: { type: "object" } & Record<string, unknown>
}

export interface ModelRequest {
  model: string
  maxTokens: number
  system: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
}

/** Mirrors the Messages API stop reasons the driver branches on. */
export type ModelStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"

/**
 * Per-call token usage — REQUIRED. These two numbers feed the `llm.call`
 * JSONL event, which is the only dollar source (plan §7 / T1b-8).
 */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
}

export interface ModelResponse {
  content: ModelContentBlock[]
  stopReason: ModelStopReason | null
  usage: ModelUsage
}

/** The single seam between the driver loop and any LLM backend. */
export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>
}
