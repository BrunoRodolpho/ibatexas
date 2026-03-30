// Budget bypass tests — verifies that sessions in checkout.* states
// are exempt from the per-session token budget gate in runAgent().
//
// These tests mock aggressively: persistence, Redis, router, schedule,
// and the Anthropic SDK, so we can isolate the budget-check logic.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Channel, type AgentContext, type StreamChunk } from "@ibatexas/types"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockLoadMachineState = vi.hoisted(() => vi.fn())
const mockPersistMachineState = vi.hoisted(() => vi.fn())
const mockGetRedisClient = vi.hoisted(() => vi.fn())
const mockRouteMessage = vi.hoisted(() => vi.fn())
const mockLoadSchedule = vi.hoisted(() => vi.fn())
const mockStream = vi.hoisted(() => vi.fn())
const mockExecuteTool = vi.hoisted(() => vi.fn())

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../machine/persistence.js", () => ({
  loadMachineState: mockLoadMachineState,
  persistMachineState: mockPersistMachineState,
}))

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>
  return {
    ...orig,
    getRedisClient: mockGetRedisClient,
    loadSchedule: mockLoadSchedule,
  }
})

vi.mock("../router.js", () => ({
  routeMessage: mockRouteMessage,
  extractCustomerName: vi.fn().mockReturnValue(null),
}))

vi.mock("../tool-registry.js", () => ({
  TOOL_DEFINITIONS: [{ name: "search_products", description: "busca", inputSchema: {} }],
  executeTool: mockExecuteTool,
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: mockStream },
  })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function createFakeRedis(tokenCount: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(tokenCount),
    set: vi.fn().mockResolvedValue("OK"),
    incrBy: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(true),
  }
}

function buildMockStream(events: object[], finalMessage: object): object {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e
    },
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
  }
}

const simpleResponse = () => {
  const events = [
    { type: "content_block_delta", delta: { type: "text_delta", text: "Confirmo!" } },
  ]
  const finalMessage = {
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Confirmo!" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  return buildMockStream(events, finalMessage)
}

async function collectChunks(
  message: string,
  context?: Partial<AgentContext>,
): Promise<StreamChunk[]> {
  const { runAgent } = await import("../agent.js")
  const ctx: AgentContext = {
    channel: Channel.WhatsApp,
    sessionId: "test-budget",
    userType: "guest",
    ...context,
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of runAgent(message, [], ctx)) {
    chunks.push(chunk)
  }
  return chunks
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("budget bypass for checkout states", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { _resetClient } = await import("../agent.js")
    _resetClient()

    // Defaults — tests override as needed
    mockLoadMachineState.mockResolvedValue(null)
    mockPersistMachineState.mockResolvedValue(undefined)
    mockRouteMessage.mockReturnValue([])
    mockLoadSchedule.mockResolvedValue(undefined)
    mockStream.mockReturnValue(simpleResponse())
  })

  it("budget exceeded + checkout.confirming → bypasses rate-limit", async () => {
    // Machine snapshot is in checkout.confirming — budget bypass must apply.
    // Only the .value field matters for isCheckoutState(); the rest of the
    // snapshot is unused because routeMessage returns [] and processEventsWithMachine
    // creates a fresh actor when the snapshot format doesn't match XState.
    mockGetRedisClient.mockResolvedValue(createFakeRedis("200000"))

    // Provide a checkout-state snapshot with XState-compatible shape.
    // The `children` and `status` fields are required by XState's restoreSnapshot.
    mockLoadMachineState.mockResolvedValue({
      value: { checkout: "confirming" },
      status: "active",
      children: {},
      context: {
        channel: "whatsapp",
        customerId: null,
        isAuthenticated: false,
        isNewCustomer: true,
        cartId: "cart-1",
        items: [{ productId: "p1", variantId: "v1", name: "Costela 1kg", category: "meat", quantity: 1, priceInCentavos: 13500 }],
        totalInCentavos: 13500,
        couponApplied: null,
        fulfillment: "pickup",
        deliveryCep: null,
        deliveryFeeInCentavos: null,
        deliveryEtaMinutes: null,
        paymentMethod: "pix",
        tipInCentavos: 0,
        upsellRound: 0,
        hasMainDish: true,
        hasSide: false,
        hasDrink: false,
        isCombo: false,
        mealPeriod: "dinner",
        lastError: null,
        pendingProduct: null,
        alternatives: [],
        lastSearchResult: null,
        checkoutResult: null,
        orderId: null,
        orderCreatedAt: null,
        lastAction: null,
        loyaltyStamps: null,
      },
    })

    const chunks: StreamChunk[] = []
    try {
      const { runAgent } = await import("../agent.js")
      for await (const chunk of runAgent("sim", [], {
        channel: Channel.WhatsApp,
        sessionId: "test-budget",
        userType: "guest",
      })) {
        chunks.push(chunk)
      }
    } catch {
      // Pipeline may error downstream, but budget check was bypassed
    }

    const rateLimitChunks = chunks
      .filter((c) => c.type === "text_delta")
      .filter((c) => (c as { delta: string }).delta.includes("meu limite"))
    expect(rateLimitChunks).toHaveLength(0)
  })

  it("budget exceeded + checkout.processing_payment → bypasses rate-limit", async () => {
    mockGetRedisClient.mockResolvedValue(createFakeRedis("200000"))
    mockLoadMachineState.mockResolvedValue({
      value: { checkout: "processing_payment" },
      status: "active",
      children: {},
      context: {
        channel: "whatsapp",
        customerId: null,
        isAuthenticated: false,
        isNewCustomer: true,
        cartId: "cart-1",
        items: [{ productId: "p1", variantId: "v1", name: "Costela 1kg", category: "meat", quantity: 1, priceInCentavos: 13500 }],
        totalInCentavos: 13500,
        couponApplied: null,
        fulfillment: "pickup",
        deliveryCep: null,
        deliveryFeeInCentavos: null,
        deliveryEtaMinutes: null,
        paymentMethod: "pix",
        tipInCentavos: 0,
        upsellRound: 0,
        hasMainDish: true,
        hasSide: false,
        hasDrink: false,
        isCombo: false,
        mealPeriod: "dinner",
        lastError: null,
        pendingProduct: null,
        alternatives: [],
        lastSearchResult: null,
        checkoutResult: null,
        orderId: null,
        orderCreatedAt: null,
        lastAction: null,
        loyaltyStamps: null,
      },
    })

    const chunks: StreamChunk[] = []
    try {
      const { runAgent } = await import("../agent.js")
      for await (const chunk of runAgent("sim", [], {
        channel: Channel.WhatsApp,
        sessionId: "test-budget",
        userType: "guest",
      })) {
        chunks.push(chunk)
      }
    } catch {
      // Pipeline may error downstream, but budget check was bypassed
    }

    const rateLimitChunks = chunks
      .filter((c) => c.type === "text_delta")
      .filter((c) => (c as { delta: string }).delta.includes("meu limite"))
    expect(rateLimitChunks).toHaveLength(0)
  })

  it("budget exceeded + idle state → rate-limit message returned", async () => {
    mockLoadMachineState.mockResolvedValue({ value: "idle" })
    mockGetRedisClient.mockResolvedValue(createFakeRedis("200000"))

    const chunks = await collectChunks("oi")

    const textChunks = chunks.filter((c) => c.type === "text_delta")
    expect(
      textChunks.some((c) => (c as { delta: string }).delta.includes("meu limite")),
    ).toBe(true)

    // LLM was never invoked
    expect(mockStream).not.toHaveBeenCalled()
  })

  it("budget exceeded + no snapshot (new session) → rate-limit message", async () => {
    mockLoadMachineState.mockResolvedValue(null)
    mockGetRedisClient.mockResolvedValue(createFakeRedis("200000"))

    const chunks = await collectChunks("oi")

    const textChunks = chunks.filter((c) => c.type === "text_delta")
    expect(
      textChunks.some((c) => (c as { delta: string }).delta.includes("meu limite")),
    ).toBe(true)
  })

  it("budget not exceeded → pipeline runs normally (no rate-limit)", async () => {
    mockLoadMachineState.mockResolvedValue(null)
    mockGetRedisClient.mockResolvedValue(createFakeRedis("500"))

    const chunks = await collectChunks("oi")

    // No rate-limit message
    const textChunks = chunks.filter((c) => c.type === "text_delta")
    expect(
      textChunks.some((c) => (c as { delta: string }).delta.includes("meu limite")),
    ).toBe(false)

    // LLM was invoked
    expect(mockStream).toHaveBeenCalled()
  })
})
