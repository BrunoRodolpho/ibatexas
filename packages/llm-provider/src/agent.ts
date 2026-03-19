// AgentOrchestrator — core agent loop for IbateXas.
//
// runAgent streams a response from Claude, handling tool calls in a loop:
//   1. Send message + history to Claude with tool definitions
//   2. Stream text deltas → yield StreamChunk { type: "text_delta" }
//   3. On tool_use stop_reason: execute tools with retry, append results, loop
//   4. On end_turn: yield { type: "done" }, stop
//
// Retry policy: each tool call retried up to 3 times with exponential backoff.
// Guard: max 10 agent turns prevents infinite loops.

import Anthropic from "@anthropic-ai/sdk"
import type { MessageParam, ToolResultBlockParam, ContentBlock } from "@anthropic-ai/sdk/resources/messages.js"
import { Channel, NonRetryableError, type AgentContext, type AgentMessage, type StreamChunk } from "@ibatexas/types"
import { SYSTEM_PROMPT } from "./system-prompt.js"
import { TOOL_DEFINITIONS, executeTool } from "./tool-registry.js"
import { getRedisClient, rk } from "@ibatexas/tools"

const MAX_TURNS = Number.parseInt(process.env.AGENT_MAX_TURNS || "10", 10)
const MAX_TOOL_RETRIES = Number.parseInt(process.env.AGENT_MAX_TOOL_RETRIES || "3", 10)
const AGENT_MAX_TOKENS = Number.parseInt(process.env.AGENT_MAX_TOKENS || "2048", 10)
// Per-conversation retry budget to prevent runaway cost
const MAX_CONVERSATION_RETRIES = Number.parseInt(process.env.AGENT_MAX_CONVERSATION_RETRIES || "10", 10)

// Daily token budget per session (default 100K tokens)
const SESSION_TOKEN_BUDGET = Number.parseInt(process.env.AGENT_SESSION_TOKEN_BUDGET || "100000", 10)
const TOKEN_BUDGET_TTL = 86400 // 24 hours in seconds

// ── Anthropic client (singleton) ──────────────────────────────────────────────

let _client: Anthropic | null = null

function getClient(): Anthropic {
  // 60s timeout prevents indefinite hangs during API outages
  _client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 60_000,
  })
  return _client
}

// ── Retry helper ──────────────────────────────────────────────────────────────

/**
 * Execute a tool with exponential backoff retry.
 * On all retries exhausted: returns an error object (never throws).
 * Claude receives the error as a tool result and can respond gracefully.
 *
 * Accepts a shared conversationRetries counter to enforce a per-conversation
 * retry budget across all tool calls.
 */
async function executeWithRetry(
  name: string,
  input: unknown,
  ctx: AgentContext,
  conversationRetries: { count: number },
): Promise<unknown> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < MAX_TOOL_RETRIES; attempt++) {
    try {
      return await executeTool(name, input, ctx)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Non-retryable errors (auth, business rules) should not be retried
      if (lastError instanceof NonRetryableError) {
        return { error: lastError.message, toolName: name }
      }
      // Track retries against conversation budget
      conversationRetries.count++
      if (conversationRetries.count >= MAX_CONVERSATION_RETRIES) {
        return { error: "Limite de tentativas atingido. Tente novamente mais tarde.", toolName: name }
      }
      if (attempt < MAX_TOOL_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
      }
    }
  }

  return { error: lastError?.message ?? "Falha desconhecida", toolName: name }
}

// ── Stream helpers ────────────────────────────────────────────────────────────

/** Stream text deltas from a Claude message stream, yielding StreamChunk for each delta. */
async function* streamTextDeltas(
  stream: ReturnType<Anthropic["messages"]["stream"]>,
): AsyncGenerator<StreamChunk> {
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield { type: "text_delta", delta: event.delta.text }
    }
  }
}

/** Process all tool_use blocks from a finalMessage, executing each with retry. */
async function processToolCalls(
  content: ContentBlock[],
  context: AgentContext,
  onChunk: (chunk: StreamChunk) => void,
  conversationRetries: { count: number },
): Promise<ToolResultBlockParam[]> {
  const toolResults: ToolResultBlockParam[] = []

  for (const block of content) {
    if (block.type !== "tool_use") continue

    onChunk({ type: "tool_start", toolName: block.name, toolUseId: block.id })

    const result = await executeWithRetry(block.name, block.input, context, conversationRetries)
    const isError = typeof result === "object" && result !== null && "error" in result

    onChunk({ type: "tool_result", toolName: block.name, toolUseId: block.id, success: !isError })

    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: JSON.stringify(result),
    })
  }

  return toolResults
}

/** Build system prompt with channel-specific hint */
function buildSystemPrompt(channel: Channel): string {
  const channelHint =
    channel === Channel.WhatsApp
      ? "\n\n[Canal atual: WhatsApp — respostas curtas, sem tabelas, URLs diretos]"
      : "\n\n[Canal atual: Web — markdown completo]"
  return SYSTEM_PROMPT + channelHint
}

// ── Per-session token budget helpers ─────────────────────────────────────────

/**
 * Check if the session has exceeded its daily token budget.
 * Returns the current token count or -1 if Redis is unavailable (fail-open).
 */
async function getSessionTokenCount(sessionId: string): Promise<number> {
  try {
    const redis = await getRedisClient()
    const count = await redis.get(rk(`llm:tokens:${sessionId}`))
    return count ? Number.parseInt(count, 10) : 0
  } catch {
    // Fail-open: if Redis is down, allow the request
    return 0
  }
}

/**
 * Increment the session's token counter after a response.
 * Sets 24h TTL on first write.
 */
async function trackSessionTokens(sessionId: string, tokensUsed: number): Promise<void> {
  try {
    const redis = await getRedisClient()
    const key = rk(`llm:tokens:${sessionId}`)
    const newCount = await redis.incrBy(key, tokensUsed)
    // Set TTL only on first increment (when count equals the tokens just added)
    if (newCount === tokensUsed) {
      await redis.expire(key, TOKEN_BUDGET_TTL)
    }
  } catch {
    // Non-critical: tracking failure should not block the agent
  }
}

// ── Main agent loop ───────────────────────────────────────────────────────────

/**
 * Run the agent loop, streaming chunks to the caller.
 *
 * @param message   — current user message
 * @param history   — prior messages in this session (oldest first)
 * @param context   — session metadata (channel, sessionId, customerId, userType)
 */
export async function* runAgent(
  message: string,
  history: AgentMessage[],
  context: AgentContext,
): AsyncGenerator<StreamChunk> {
  // Check per-session token budget before processing
  const currentTokens = await getSessionTokenCount(context.sessionId)
  if (currentTokens >= SESSION_TOKEN_BUDGET) {
    yield { type: "text_delta", delta: "Limite de uso atingido. Tente novamente amanhã." }
    yield { type: "done", inputTokens: 0, outputTokens: 0 }
    return
  }

  const client = getClient()
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"

  // Build mutable messages array — grows as tool results are appended
  const messages: MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content } as MessageParam)),
    { role: "user", content: message },
  ]

  const systemPrompt = buildSystemPrompt(context.channel)

  // Per-conversation retry budget shared across all tool calls
  const conversationRetries = { count: 0 }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // ── Stream one turn ─────────────────────────────────────────────────────
    let stream: ReturnType<typeof client.messages.stream>
    try {
      stream = client.messages.stream({
        model,
        system: systemPrompt,
        messages,
        tools: TOOL_DEFINITIONS,
        max_tokens: AGENT_MAX_TOKENS,
      })
    } catch (err) {
      console.error("[agent] Failed to start stream:", (err as Error).message)
      yield { type: "error", message: "Erro ao processar sua mensagem. Tente novamente." }
      return
    }

    // Yield text deltas as they arrive
    try {
      yield* streamTextDeltas(stream)
    } catch (err) {
      console.error("[agent] Stream error:", (err as Error).message)
      yield { type: "error", message: "Erro ao processar sua mensagem. Tente novamente." }
      return
    }

    const finalMessage = await stream.finalMessage()
    const { stop_reason, usage } = finalMessage

    // Track token usage after each turn
    const turnTokens = usage.input_tokens + usage.output_tokens
    void trackSessionTokens(context.sessionId, turnTokens)

    // ── End turn — finish gracefully ──────────────────────────────────────
    if (stop_reason === "end_turn") {
      yield {
        type: "done",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }
      return
    }

    // When response is truncated by max_tokens, signal to the client
    if (stop_reason === "max_tokens") {
      yield { type: "text_delta", delta: "\n\n[Resposta truncada — limite de tamanho atingido.]" }
      yield {
        type: "done",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }
      return
    }

    // ── Tool use ────────────────────────────────────────────────────────────
    if (stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: finalMessage.content })

      const pendingChunks: StreamChunk[] = []
      const toolResults = await processToolCalls(
        finalMessage.content,
        context,
        (chunk) => pendingChunks.push(chunk),
        conversationRetries,
      )
      for (const chunk of pendingChunks) {
        yield chunk
      }

      // Feed all tool results back to Claude as a single user message
      messages.push({ role: "user", content: toolResults })
      continue
    }

    // ── Unexpected stop reason ───────────────────────────────────────────────
    yield { type: "error", message: `Stop inesperado: ${stop_reason}` }
    return
  }

  yield { type: "error", message: "Limite de turnos do agente atingido." }
}
