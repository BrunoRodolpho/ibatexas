// Edge-case tests for runAgent — covers gaps from the deep review:
// - max_tokens stop_reason (graceful finish, not error)
// - MAX_TURNS exhaustion
// - Multiple tools in a single turn
// - Stream error handling
// - History with messages

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Channel, type AgentContext, type StreamChunk } from "@ibatexas/types"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockExecuteTool = vi.hoisted(() => vi.fn())
const mockStream = vi.hoisted(() => vi.fn())

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

async function collectChunks(
  message: string,
  history = [] as Array<{ role: "user" | "assistant"; content: string }>,
  context?: AgentContext,
): Promise<StreamChunk[]> {
  const { runAgent } = await import("../agent.js")
  const ctx: AgentContext = context ?? {
    channel: Channel.Web,
    sessionId: "test-session",
    userType: "guest",
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of runAgent(message, history, ctx)) {
    chunks.push(chunk)
  }
  return chunks
}

function buildMockStream(events: object[], finalMessage: object): object {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e
    },
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAgent edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("max_tokens stop_reason yields done (not error)", async () => {
    const events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Resposta parcial..." } },
    ]
    const finalMessage = {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Resposta parcial..." }],
      usage: { input_tokens: 50, output_tokens: 2048 },
    }

    mockStream.mockReturnValue(buildMockStream(events, finalMessage))

    const chunks = await collectChunks("conte uma história longa")

    // AUDIT-FIX: AI-F07 — max_tokens now emits an extra text_delta with truncation indicator
    const textChunks = chunks.filter((c) => c.type === "text_delta")
    expect(textChunks).toHaveLength(2)
    // Second text_delta is the truncation indicator
    expect(textChunks[1].delta).toContain("truncada")

    const doneChunk = chunks.find((c) => c.type === "done")
    expect(doneChunk).toBeDefined()
    expect((doneChunk as { type: "done"; outputTokens?: number }).outputTokens).toBe(2048)

    // Should NOT have an error chunk
    const errorChunk = chunks.find((c) => c.type === "error")
    expect(errorChunk).toBeUndefined()
  })

  it("MAX_TURNS exhaustion yields error message", async () => {
    // Every turn requests a tool, causing the loop to continue indefinitely
    const toolFinal = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "search_products", input: { query: "loop" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }

    // Return the same tool_use response for every call (up to MAX_TURNS=10)
    mockStream.mockReturnValue(buildMockStream([], toolFinal))
    mockExecuteTool.mockResolvedValue({ products: [] })

    const chunks = await collectChunks("loop infinito")

    // Should eventually get an error about max turns
    const errorChunk = chunks.find((c) => c.type === "error")
    expect(errorChunk).toBeDefined()
    expect((errorChunk as { type: "error"; message: string }).message).toContain("turnos")
  })

  it("multiple tool calls in a single turn", async () => {
    const turn1Final = {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "search_products", input: { query: "costela" } },
        { type: "tool_use", id: "t2", name: "search_products", input: { query: "frango" } },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    }

    const turn2Events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Encontrei ambos!" } },
    ]
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Encontrei ambos!" }],
      usage: { input_tokens: 40, output_tokens: 8 },
    }

    mockStream
      .mockReturnValueOnce(buildMockStream([], turn1Final))
      .mockReturnValueOnce(buildMockStream(turn2Events, turn2Final))

    mockExecuteTool.mockResolvedValue({ products: [{ id: "p1", title: "Costela" }] })

    const chunks = await collectChunks("costela e frango")

    // Should have 2 tool_start and 2 tool_result chunks
    const toolStarts = chunks.filter((c) => c.type === "tool_start")
    const toolResults = chunks.filter((c) => c.type === "tool_result")
    expect(toolStarts).toHaveLength(2)
    expect(toolResults).toHaveLength(2)

    // executeTool called twice
    expect(mockExecuteTool).toHaveBeenCalledTimes(2)

    const doneChunk = chunks.find((c) => c.type === "done")
    expect(doneChunk).toBeDefined()
  })

  it("stream error yields error chunk instead of crashing", async () => {
    mockStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Início..." } }
        throw new Error("Connection reset")
      },
      finalMessage: vi.fn().mockRejectedValue(new Error("Connection reset")),
    })

    const chunks = await collectChunks("olá")

    const errorChunk = chunks.find((c) => c.type === "error")
    expect(errorChunk).toBeDefined()
    // Error message is sanitized — no SDK internals leak to the client
    expect((errorChunk as { type: "error"; message: string }).message).toContain("Tente novamente")
  })

  it("passes history messages correctly", async () => {
    const events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "Claro!" } },
    ]
    const finalMessage = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Claro!" }],
      usage: { input_tokens: 20, output_tokens: 3 },
    }

    mockStream.mockReturnValue(buildMockStream(events, finalMessage))

    const history = [
      { role: "user" as const, content: "oi" },
      { role: "assistant" as const, content: "Olá! Como posso ajudar?" },
    ]

    await collectChunks("tem costela?", history)

    // Verify stream was called with history + new message
    expect(mockStream).toHaveBeenCalledOnce()
    const callArgs = mockStream.mock.calls[0]![0]
    expect(callArgs.messages).toHaveLength(3) // 2 history + 1 new
    expect(callArgs.messages[0]).toEqual({ role: "user", content: "oi" })
    expect(callArgs.messages[1]).toEqual({ role: "assistant", content: "Olá! Como posso ajudar?" })
    expect(callArgs.messages[2]).toEqual({ role: "user", content: "tem costela?" })
  })
})
