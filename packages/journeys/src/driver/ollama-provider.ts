// driver/ollama-provider.ts — ModelProvider over a local Ollama OpenAI-compat
// /v1 endpoint (e.g. nemotron-3-nano:4b). The Anthropic-block <-> OpenAI
// translation twin of anthropic-provider.ts: the persona driver speaks the
// neutral Anthropic-block ModelRequest/Response; this adapter owns nothing but
// the wire mapping to /v1/chat/completions.
//
// No `openai` npm dependency — a structural fetch client. Selected by the
// caller when IBX_DRIVER_PROVIDER=ollama (run-journey-cli wiring).
//
// Tool names: OpenAI requires /^[a-zA-Z0-9_-]+$/, so dotted intent kinds are
// mapped `.`->`_` outbound and reversed inbound against the request's tool set
// (and the assistant history's prior tool_use names). Malformed tool arguments
// surface as { __raw } so the loop still routes to the right tool.

import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
} from "./model-provider.js"

const DEFAULT_BASE_URL = "http://192.168.1.80:11434/v1"
const DEFAULT_MODEL = "nemotron-3-nano:4b"

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

const wireName = (name: string): string => name.replaceAll(".", "_")

/** Reverse a wire name to an original name using the known name set. */
function originalName(wire: string, known: ReadonlyArray<string>): string {
  const exact = known.find((n) => n === wire)
  if (exact !== undefined) return exact
  const mapped = known.find((n) => wireName(n) === wire)
  return mapped ?? wire
}

function toOpenAIMessages(messages: ModelMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (const message of messages) {
    if (message.role === "assistant") {
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []
      for (const block of message.content) {
        if (block.type === "text") textParts.push(block.text)
        else
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: wireName(block.name), arguments: JSON.stringify(block.input ?? {}) },
          })
      }
      out.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    if (typeof message.content === "string") {
      out.push({ role: "user", content: message.content })
      continue
    }
    // user with tool_result[] -> one role:"tool" message per result (OpenAI shape)
    for (const result of message.content) {
      out.push({
        role: "tool",
        tool_call_id: result.toolUseId,
        content: result.isError === true ? `Tool failed: ${result.content}` : result.content,
      })
    }
  }
  return out
}

function normalizeStopReason(finish: string | null | undefined, hasToolUse: boolean): ModelStopReason | null {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tool_use"
    case "length":
      return "max_tokens"
    case "content_filter":
      return "refusal"
    case "stop":
      return hasToolUse ? "tool_use" : "end_turn"
    case null:
    case undefined:
      return hasToolUse ? "tool_use" : "end_turn"
    default:
      return "end_turn"
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface OllamaModelProviderOptions {
  baseUrl?: string
  model?: string
  /** Bearer token for the /v1 endpoint. Ollama ignores it; any non-empty value works. */
  apiKey?: string
}

export function createOllamaModelProvider(options: OllamaModelProviderOptions = {}): ModelProvider {
  const baseUrl = options.baseUrl ?? process.env.IBX_DRIVER_BASE_URL ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL
  const apiKey = options.apiKey ?? process.env.IBX_DRIVER_API_KEY ?? "ollama"

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const knownToolNames = request.tools.map((t) => t.name)
      const body = {
        model: options.model ?? request.model,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system" as const, content: request.system },
          ...toOpenAIMessages(request.messages),
        ],
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: { name: wireName(tool.name), description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
        stream: false,
      }
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(`Ollama /v1 HTTP ${res.status}: ${await res.text()}`)
      }
      const json = (await res.json()) as OpenAIResponse
      const message = json.choices?.[0]?.message
      const blocks: ModelContentBlock[] = []
      if (typeof message?.content === "string" && message.content.length > 0) {
        blocks.push({ type: "text", text: message.content })
      }
      for (const tc of message?.tool_calls ?? []) {
        let input: Record<string, unknown>
        try {
          input = tc.function.arguments.length > 0 ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
        } catch {
          input = { __raw: tc.function.arguments }
        }
        blocks.push({ type: "tool_use", id: tc.id, name: originalName(tc.function.name, knownToolNames), input })
      }
      const hasToolUse = blocks.some((b) => b.type === "tool_use")
      return {
        content: blocks,
        stopReason: normalizeStopReason(json.choices?.[0]?.finish_reason, hasToolUse),
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      }
    },
  }
}
