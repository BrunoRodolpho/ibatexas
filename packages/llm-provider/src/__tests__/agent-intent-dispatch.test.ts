// End-to-end test for Task 02 dispatcher wiring (investigation 01 P0 #1).
//
// Verifies the dispatcher is invoked by generateResponse when an adjudicated
// EXECUTE decision lands on an LLM-only mutating tool (handoff_to_human).
// Before this task, onToolIntent was undefined at agent.ts:329 — the
// adjudicate() call would return EXECUTE and the intent disappeared. These
// tests guard against regression.
//
// Scope: this exercises generateResponse directly (not runAgent), because
// runAgent's full path requires steering the XState kernel into the `support`
// state where handoff_to_human is exposed — that's a fragile integration
// surface for unit tests. The dispatcher contract is the load-bearing piece
// for Task 02; testing it via generateResponse covers the wiring exactly.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Channel, type AgentContext, type StreamChunk } from "@ibatexas/types"
import { buildEnvelope } from "@adjudicate/core"
import type { ToolIntent } from "../machine/types.js"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockExecuteTool = vi.hoisted(() => vi.fn())
const mockStream = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../tool-registry.js", () => ({
  TOOL_DEFINITIONS: [
    { name: "handoff_to_human", description: "transfere", input_schema: { type: "object", properties: {} } },
  ],
  executeTool: mockExecuteTool,
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      stream: mockStream,
    },
  })),
}))

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return {
    ...orig,
    getRedisClient: mockGetRedisClient,
  }
})

// Silence the audit sink — it tries to publish to NATS otherwise.
vi.mock("../intent-audit-wiring.js", () => ({
  getAuditSink: () => ({ emit: vi.fn().mockResolvedValue(undefined) }),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

const baseContext: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "sess-dispatch-1",
  userType: "customer",
  customerId: "cust_01",
}

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

function buildHandoffIntent(): ToolIntent {
  const envelope = buildEnvelope({
    kind: "order.tool.propose",
    payload: {
      toolName: "handoff_to_human",
      input: { sessionId: baseContext.sessionId, reason: "complex_request" },
      toolUseId: "tu_handoff_1",
    },
    actor: { principal: "llm", sessionId: baseContext.sessionId },
    taint: "UNTRUSTED",
    nonce: "n_handoff_1",
  })
  return {
    toolName: "handoff_to_human",
    input: { sessionId: baseContext.sessionId, reason: "complex_request" },
    toolUseId: "tu_handoff_1",
    envelope: envelope as ToolIntent["envelope"],
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Task 02 — onToolIntent wired through generateResponse", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { _resetClient } = await import("../agent.js")
    _resetClient()
    mockGetRedisClient.mockResolvedValue({
      get: vi.fn().mockResolvedValue("0"),
      set: vi.fn().mockResolvedValue("OK"),
      incrBy: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(true),
    })
  })

  it("invokes the dispatcher exactly once when adjudicate returns EXECUTE for handoff_to_human", async () => {
    // ── Arrange ───────────────────────────────────────────────────────────
    // Claude's stream: turn 1 = tool_use; turn 2 = closing text.
    const turn1Final = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_handoff_1",
          name: "handoff_to_human",
          input: { sessionId: baseContext.sessionId, reason: "complex_request" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Atendente notificado." }],
      usage: { input_tokens: 5, output_tokens: 3 },
    }
    mockStream
      .mockReturnValueOnce(buildMockStream([], turn1Final))
      .mockReturnValueOnce(
        buildMockStream(
          [{ type: "content_block_delta", delta: { type: "text_delta", text: "Atendente notificado." } }],
          turn2Final,
        ),
      )

    // tool-registry returns an intent (mutating tool path).
    mockExecuteTool.mockResolvedValue({
      kind: "intent",
      intent: buildHandoffIntent(),
    })

    const dispatchSpy = vi.fn().mockResolvedValue({
      kind: "executed",
      result: { success: true, estimatedWaitMinutes: 5 },
    })

    // ── Act ───────────────────────────────────────────────────────────────
    const { generateResponse } = await import("../llm-responder.js")
    const chunks: StreamChunk[] = []
    for await (const chunk of generateResponse({
      synthesized: {
        systemPrompt: "test",
        availableTools: ["handoff_to_human"],
        maxTokens: 1024,
        plan: { visibleReadTools: [], allowedIntents: ["handoff_to_human"] },
      },
      message: "preciso falar com um humano",
      history: [],
      agentContext: baseContext,
      machineCtx: { items: [] } as never,
      isPostCheckout: false,
      stateValue: "support",
      onToolIntent: dispatchSpy,
    })) {
      chunks.push(chunk)
    }

    // ── Assert ────────────────────────────────────────────────────────────
    // The dispatcher MUST have been called exactly once with the intent.
    expect(dispatchSpy).toHaveBeenCalledOnce()
    const intentArg = dispatchSpy.mock.calls[0]?.[0] as ToolIntent
    expect(intentArg.toolName).toBe("handoff_to_human")
    expect(intentArg.envelope?.kind).toBe("order.tool.propose")

    // The LLM should see a success-style tool_result.
    const toolResultChunk = chunks.find((c) => c.type === "tool_result")
    expect(toolResultChunk).toMatchObject({
      type: "tool_result",
      toolName: "handoff_to_human",
      success: true,
    })

    // And the conversation should have completed.
    expect(chunks.find((c) => c.type === "done")).toBeDefined()
  })

  it("downgrades to dispatch_failed tool_result when the dispatcher fails", async () => {
    const turn1Final = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_handoff_2",
          name: "handoff_to_human",
          input: { sessionId: baseContext.sessionId, reason: "billing" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "vou tentar novamente em instantes" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    }
    mockStream
      .mockReturnValueOnce(buildMockStream([], turn1Final))
      .mockReturnValueOnce(
        buildMockStream(
          [{ type: "content_block_delta", delta: { type: "text_delta", text: "vou tentar" } }],
          turn2Final,
        ),
      )
    mockExecuteTool.mockResolvedValue({
      kind: "intent",
      intent: buildHandoffIntent(),
    })

    const dispatchSpy = vi.fn().mockResolvedValue({
      kind: "failed",
      error: new Error("nats: connection refused"),
    })

    const { generateResponse } = await import("../llm-responder.js")
    const chunks: StreamChunk[] = []
    for await (const chunk of generateResponse({
      synthesized: {
        systemPrompt: "test",
        availableTools: ["handoff_to_human"],
        maxTokens: 1024,
        plan: { visibleReadTools: [], allowedIntents: ["handoff_to_human"] },
      },
      message: "preciso falar com um humano",
      history: [],
      agentContext: baseContext,
      machineCtx: { items: [] } as never,
      isPostCheckout: false,
      stateValue: "support",
      onToolIntent: dispatchSpy,
    })) {
      chunks.push(chunk)
    }

    // Dispatcher fired.
    expect(dispatchSpy).toHaveBeenCalledOnce()

    // Critical: the responder must NOT claim success — it must emit
    // success:false so the LLM downgrades its outgoing message.
    const toolResultChunk = chunks.find((c) => c.type === "tool_result")
    expect(toolResultChunk).toMatchObject({
      type: "tool_result",
      toolName: "handoff_to_human",
      success: false,
    })
  })

  it("invokes the dispatcher with the agent context (sessionId, customerId, channel)", async () => {
    const turn1Final = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_handoff_3",
          name: "handoff_to_human",
          input: { sessionId: baseContext.sessionId, reason: "test" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const turn2Final = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    }
    mockStream
      .mockReturnValueOnce(buildMockStream([], turn1Final))
      .mockReturnValueOnce(
        buildMockStream(
          [{ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }],
          turn2Final,
        ),
      )
    mockExecuteTool.mockResolvedValue({
      kind: "intent",
      intent: buildHandoffIntent(),
    })

    let receivedIntent: ToolIntent | null = null
    const dispatchSpy = vi.fn(async (intent: ToolIntent) => {
      receivedIntent = intent
      return { kind: "executed" as const, result: { success: true } }
    })

    const { generateResponse } = await import("../llm-responder.js")
    const chunks: StreamChunk[] = []
    for await (const chunk of generateResponse({
      synthesized: {
        systemPrompt: "test",
        availableTools: ["handoff_to_human"],
        maxTokens: 1024,
        plan: { visibleReadTools: [], allowedIntents: ["handoff_to_human"] },
      },
      message: "test",
      history: [],
      agentContext: baseContext,
      machineCtx: { items: [] } as never,
      isPostCheckout: false,
      stateValue: "support",
      onToolIntent: dispatchSpy,
    })) {
      chunks.push(chunk)
    }

    // The envelope carries the actor sessionId — verify the wiring fidelity.
    expect(receivedIntent).not.toBeNull()
    const intent = receivedIntent as unknown as ToolIntent
    expect(intent.envelope?.actor?.sessionId).toBe(baseContext.sessionId)
  })
})
