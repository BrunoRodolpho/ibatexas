// driver/anthropic-provider.ts — the real ModelProvider over @anthropic-ai/sdk.
//
// Thin adapter: neutral ModelRequest → `client.messages.create()` → neutral
// ModelResponse. The driver loop, budgets, and trace events all live in
// persona-driver.ts; this file owns nothing but the wire mapping.
//
// Model selection is the CALLER's job (the driver resolves IBX_DRIVER_MODEL,
// default claude-sonnet-4-6 — D-010 pins the certification model; the driver
// model is configured independently because the driver accumulates context,
// plan §7 cost note). ANTHROPIC_API_KEY is read by the SDK from the
// environment — never logged, never threaded through options here.

import Anthropic from "@anthropic-ai/sdk"

import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
} from "./model-provider.js"

function toSdkMessage(message: ModelMessage): Anthropic.Messages.MessageParam {
  if (message.role === "assistant") {
    const content: Anthropic.Messages.ContentBlockParam[] = message.content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "tool_use", id: block.id, name: block.name, input: block.input },
    )
    return { role: "assistant", content }
  }
  if (typeof message.content === "string") {
    return { role: "user", content: message.content }
  }
  const content: Anthropic.Messages.ContentBlockParam[] = message.content.map((result) => ({
    type: "tool_result",
    tool_use_id: result.toolUseId,
    content: result.content,
    ...(result.isError === true ? { is_error: true } : {}),
  }))
  return { role: "user", content }
}

function fromSdkContent(content: Anthropic.Messages.ContentBlock[]): ModelContentBlock[] {
  const blocks: ModelContentBlock[] = []
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text })
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      })
    }
    // Any other block kind (thinking, server tools…) is provider-internal —
    // the driver's closed act-tool loop only consumes text + tool_use.
  }
  return blocks
}

export interface AnthropicModelProviderOptions {
  /** Injected SDK client (tests / custom config). Default: `new Anthropic()`. */
  client?: Anthropic
}

/** Real provider: one `messages.create()` per `complete()` call. */
export function createAnthropicModelProvider(
  options: AnthropicModelProviderOptions = {},
): ModelProvider {
  const client = options.client ?? new Anthropic()

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map(toSdkMessage),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
        })),
      })

      return {
        content: fromSdkContent(response.content),
        stopReason: response.stop_reason as ModelStopReason | null,
        usage: {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
        },
      }
    },
  }
}
