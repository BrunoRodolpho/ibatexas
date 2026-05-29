import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  getNatsConnection,
  publishNatsEvent,
  subscribeNatsEvent,
  setDlqHandler,
  setOutboxWriter,
  closeNatsConnection,
} from "../index.js"

// Messages the next subscription will yield from its async iterator. Each test
// can push raw bytes here; the iterator drains them then ends the loop.
let pendingMessages: Uint8Array[] = []

// Mock the nats module with a proper implementation
vi.mock("nats", () => {
  const mockSubscription = {
    unsubscribe: vi.fn(),
    [Symbol.asyncIterator]: () => {
      const queue = pendingMessages
      pendingMessages = []
      let i = 0
      return {
        async next() {
          if (i < queue.length) {
            return { done: false, value: { data: queue[i++] } }
          }
          return { done: true, value: undefined }
        },
      }
    },
  }

  const mockConnection = {
    publish: vi.fn(),
    subscribe: vi.fn(() => mockSubscription),
    close: vi.fn(),
    drain: vi.fn(),
  }

  return {
    connect: vi.fn(async () => mockConnection),
  }
})

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

/** Let the fire-and-forget subscription loop drain its queued messages. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe("NATS Client", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingMessages = []
    // Reset module-level singletons so test order never matters.
    setDlqHandler(() => {})
    setOutboxWriter({ lPush: vi.fn(), lRem: vi.fn() })
  })

  it("publishNatsEvent encodes JSON and publishes to correct subject", async () => {
    const testEvent = "cart.abandoned"
    const testPayload = { cartId: "cart_123", userId: "user_456" }

    await publishNatsEvent(testEvent, testPayload)

    // Get the mock connection to verify publish was called
    const conn = await getNatsConnection()
    expect(conn.publish).toHaveBeenCalledWith(
      "ibatexas.cart.abandoned",
      expect.any(Uint8Array),
    )

    // Verify the encoded payload is correct JSON
    const publishCall = (conn.publish as ReturnType<typeof vi.fn>).mock.calls[0]
    const encoded = publishCall?.[1] as Uint8Array
    const decoded = JSON.parse(new TextDecoder().decode(encoded))
    expect(decoded).toEqual(testPayload)
  })

  it("publishNatsEvent swallows errors gracefully", async () => {
    const testEvent = "order.placed"
    const testPayload = { orderId: "order_123" }

    // Should not reject even without a real NATS connection
    await expect(publishNatsEvent(testEvent, testPayload)).resolves.not.toThrow()
  })

  it("subscribeNatsEvent returns a subscription handle", async () => {
    const testEvent = "product.updated"
    const handler = vi.fn()

    // Call the function - it should return an object with unsubscribe
    const subscription = await subscribeNatsEvent(testEvent, handler)

    // Verify it has the unsubscribe method
    expect(subscription).toBeDefined()
    expect(subscription).toHaveProperty("unsubscribe")
    expect(typeof subscription.unsubscribe).toBe("function")
  })

  it("subscribeNatsEvent returns object with unsubscribe callable", async () => {
    const testEvent = "inventory.changed"
    const handler = vi.fn()

    const subscription = await subscribeNatsEvent(testEvent, handler)

    // unsubscribe should be callable
    expect(() => {
      subscription.unsubscribe()
    }).not.toThrow()
  })

  it("getNatsConnection can be called without error", async () => {
    const conn = await getNatsConnection()
    expect(conn).toBeDefined()
    expect(conn).toHaveProperty("publish")
    expect(conn).toHaveProperty("subscribe")
    expect(conn).toHaveProperty("close")
  })

  it("closeNatsConnection completes without error", async () => {
    // Get a connection first
    await getNatsConnection()

    // Close should not reject
    await expect(closeNatsConnection()).resolves.not.toThrow()
  })

  // ── P1-CONC-QUEUEGROUP ──────────────────────────────────────────────────────
  it("subscribeNatsEvent subscribes with the stable queue group by default", async () => {
    await subscribeNatsEvent("order.placed", vi.fn())

    const conn = await getNatsConnection()
    expect(conn.subscribe).toHaveBeenCalledWith(
      "ibatexas.order.placed",
      { queue: "ibatexas-workers" },
    )
  })

  it("subscribeNatsEvent honors an explicit queue-group override", async () => {
    await subscribeNatsEvent("order.placed", vi.fn(), { queue: "custom-pool" })

    const conn = await getNatsConnection()
    expect(conn.subscribe).toHaveBeenCalledWith(
      "ibatexas.order.placed",
      { queue: "custom-pool" },
    )
  })

  // ── P1-ERR-NATSLOOP ─────────────────────────────────────────────────────────
  it("routes an unhandled subscriber error through the injected DLQ handler", async () => {
    const dlq = vi.fn()
    setDlqHandler(dlq)

    const boom = new Error("handler blew up")
    const handler = vi.fn().mockRejectedValue(boom)

    // Queue one message that the handler will reject on.
    pendingMessages = [encode({ orderId: "ord_1" })]
    await subscribeNatsEvent("order.placed", handler)
    await flushMicrotasks()

    expect(handler).toHaveBeenCalledWith({ orderId: "ord_1" })
    expect(dlq).toHaveBeenCalledWith("order.placed", { orderId: "ord_1" }, boom)
  })

  it("does not invoke the DLQ handler when the subscriber succeeds", async () => {
    const dlq = vi.fn()
    setDlqHandler(dlq)

    pendingMessages = [encode({ orderId: "ord_ok" })]
    await subscribeNatsEvent("order.placed", vi.fn().mockResolvedValue(undefined))
    await flushMicrotasks()

    expect(dlq).not.toHaveBeenCalled()
  })

  // ── P1-SCALE-OUTBOXMEM (writer-side cap) ─────────────────────────────────────
  it("trims the outbox list after lPush for critical events", async () => {
    const writer = {
      lPush: vi.fn().mockResolvedValue(1),
      lRem: vi.fn().mockResolvedValue(1),
      lTrim: vi.fn().mockResolvedValue("OK"),
    }
    setOutboxWriter(writer)

    await publishNatsEvent("order.placed", { orderId: "ord_2" })

    expect(writer.lPush).toHaveBeenCalledTimes(1)
    // Keeps a bounded head window [0, MAX-1]; default MAX = 5000.
    expect(writer.lTrim).toHaveBeenCalledWith(
      expect.stringContaining(":outbox:order.placed"),
      0,
      4999,
    )
  })
})


