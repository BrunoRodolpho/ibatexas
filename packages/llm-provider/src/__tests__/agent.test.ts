// Unit tests for runAgent
// Mock-based; no network or real Claude API calls.
//
// Scenarios:
// 1. Simple text response — no tools; yields text_delta chunks + done
// 2. Tool call → success → text — tool_use stop reason, tool executes, second turn yields text + done
// 3. Tool error → retry → success — tool throws twice, succeeds on 3rd attempt
// 4. Tool error → max retries → error result — tool throws 3 times, error passed to Claude

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Channel, type AgentContext, type StreamChunk } from "@ibatexas/types"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockExecuteTool = vi.hoisted(() => vi.fn())
const mockStream = vi.hoisted(() => vi.fn())

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../tool-registry.js", () => ({
  TOOL_DEFINITIONS: [{ name: "search_products", description: "busca", inputSchema: {} }],
  executeTool: mockExecuteTool,
}))

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        stream: mockStream,
      },
    })),
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all chunks from runAgent into an array */
async function collectChunks(
  message: string,
  history = [] as Array<{ role: "user" | "assistant"; content: string }>,
  context: AgentContext = {
    channel: Channel.Web,
    sessionId: "test-session",
    userType: "guest",
  },
): Promise<StreamChunk[]> {
  const { runAgent } = await import("../agent.js")
  const chunks: StreamChunk[] = []
  for await (const chunk of runAgent(message, history, context)) {
    chunks.push(chunk)
  }
  return chunks
}

/**
 * Build a mock stream that simulates Claude's streaming API.
 *
 * @param events       — async iterable events (content_block_delta, etc.)
 * @param finalMessage — the resolved final message
 */
function buildMockStream(
  events: object[],
  finalMessage: object,
): object {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e
    },
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const baseContext: AgentContext = {
  channel: Channel.Web,
  sessionId: "sess-1",
  userType: "guest",
}

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("simple text response — yields text_delta chunks and done", async () => {
    const events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Olá, " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "como posso ajudar?" } },
    ]
    const finalMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Olá, como posso ajudar?" }],
      usage: { input_tokens: 10, output_tokens: 8 },
    }

    mockStream.mockReturnValue(buildMockStream(events, finalMessage))

    const chunks = await collectChunks("oi", [], baseContext)

    const textChunks = chunks.filter((c) => c.type === "text_delta")
    const doneChunk = chunks.find((c) => c.type === "done")

    expect(textChunks).toHaveLength(2)
    expect((textChunks[0] as { type: "text_delta"; delta: string }).delta).toBe("Olá, ")
    expect((textChunks[1] as { type: "text_delta"; delta: string }).delta).toBe("como posso ajudar?")
    expect(doneChunk).toBeDefined()
    expect((doneChunk as { type: "done"; inputTokens?: number }).inputTokens).toBe(10)
  })

  it("tool call → success → text response", async () => {
    const toolUseId = "tool-use-1"

    // Turn 1: Claude requests a tool
    const turn1Events: object[] = []
    const turn1Final = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "search_products",
          input: { query: "costela" },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 5 },
    }

    // Turn 2: Claude responds with text after tool result
    const turn2Events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Encontrei costela!" } },
    ]
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Encontrei costela!" }],
      usage: { input_tokens: 30, output_tokens: 10 },
    }

    mockStream
      .mockReturnValueOnce(buildMockStream(turn1Events, turn1Final))
      .mockReturnValueOnce(buildMockStream(turn2Events, turn2Final))

    mockExecuteTool.mockResolvedValue({ products: [{ id: "prod-1", title: "Costela Defumada" }] })

    const chunks = await collectChunks("tem costela?", [], baseContext)

    expect(mockExecuteTool).toHaveBeenCalledOnce()
    expect(mockExecuteTool).toHaveBeenCalledWith("search_products", { query: "costela" }, baseContext)

    const toolStart = chunks.find((c) => c.type === "tool_start")
    const toolResult = chunks.find((c) => c.type === "tool_result")
    const textChunks = chunks.filter((c) => c.type === "text_delta")
    const doneChunk = chunks.find((c) => c.type === "done")

    expect(toolStart).toMatchObject({ type: "tool_start", toolName: "search_products", toolUseId })
    expect(toolResult).toMatchObject({ type: "tool_result", success: true })
    expect(textChunks).toHaveLength(1)
    expect(doneChunk).toBeDefined()
  })

  it("tool error → retry → success on 3rd attempt", async () => {
    const toolUseId = "tool-retry-1"

    const turn1Final = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: toolUseId, name: "search_products", input: { query: "frango" } }],
      usage: { input_tokens: 15, output_tokens: 3 },
    }
    const turn2Events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Frango disponível." } },
    ]
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Frango disponível." }],
      usage: { input_tokens: 25, output_tokens: 6 },
    }

    mockStream
      .mockReturnValueOnce(buildMockStream([], turn1Final))
      .mockReturnValueOnce(buildMockStream(turn2Events, turn2Final))

    // Fail twice, succeed on 3rd attempt
    mockExecuteTool
      .mockRejectedValueOnce(new Error("Typesense timeout"))
      .mockRejectedValueOnce(new Error("Typesense timeout"))
      .mockResolvedValueOnce({ products: [{ id: "prod-2", title: "Frango Assado" }] })

    const chunks = await collectChunks("tem frango?", [], baseContext)

    expect(mockExecuteTool).toHaveBeenCalledTimes(3)

    const toolResult = chunks.find((c) => c.type === "tool_result")
    expect(toolResult).toMatchObject({ type: "tool_result", success: true })

    const doneChunk = chunks.find((c) => c.type === "done")
    expect(doneChunk).toBeDefined()
  })

  it("tool error → max retries exhausted → error result passed to Claude", async () => {
    const toolUseId = "tool-fail-1"

    const turn1Final = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: toolUseId, name: "search_products", input: { query: "peixe" } }],
      usage: { input_tokens: 12, output_tokens: 3 },
    }
    // Claude recovers gracefully after receiving the error result
    const turn2Events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Desculpe, não consegui buscar." } },
    ]
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Desculpe, não consegui buscar." }],
      usage: { input_tokens: 22, output_tokens: 8 },
    }

    mockStream
      .mockReturnValueOnce(buildMockStream([], turn1Final))
      .mockReturnValueOnce(buildMockStream(turn2Events, turn2Final))

    // All 3 attempts fail
    mockExecuteTool.mockRejectedValue(new Error("Service unavailable"))

    const chunks = await collectChunks("tem peixe?", [], baseContext)

    expect(mockExecuteTool).toHaveBeenCalledTimes(3)

    // Tool result chunk should indicate failure
    const toolResult = chunks.find((c) => c.type === "tool_result")
    expect(toolResult).toMatchObject({ type: "tool_result", success: false })

    // Agent should still yield a text response (Claude handled the error gracefully)
    const textChunks = chunks.filter((c) => c.type === "text_delta")
    expect(textChunks.length).toBeGreaterThan(0)

    const doneChunk = chunks.find((c) => c.type === "done")
    expect(doneChunk).toBeDefined()
  })
})
