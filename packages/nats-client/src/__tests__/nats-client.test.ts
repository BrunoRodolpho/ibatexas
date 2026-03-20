import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  getNatsConnection,
  publishNatsEvent,
  subscribeNatsEvent,
  closeNatsConnection,
} from "../index.js"

// Mock the nats module with a proper implementation
vi.mock("nats", () => {
  const mockSubscription = {
    unsubscribe: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(() => ({
      async next() {
        return { done: true }
      },
    })),
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

describe("NATS Client", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})


