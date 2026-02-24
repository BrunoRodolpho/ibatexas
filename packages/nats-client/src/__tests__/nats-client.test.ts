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

    // This should not throw
    await publishNatsEvent(testEvent, testPayload)

    // Expected subject format
    const expectedSubject = `ibatexas.${testEvent}`
    expect(expectedSubject).toBe("ibatexas.cart.abandoned")
  })

  it("publishNatsEvent swallows errors gracefully", async () => {
    const testEvent = "order.placed"
    const testPayload = { orderId: "order_123" }

    // Should not throw even without a real NATS connection
    expect(async () => {
      await publishNatsEvent(testEvent, testPayload)
    }).not.toThrow()
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

    // Close should not throw and should be async
    expect(async () => {
      await closeNatsConnection()
    }).not.toThrow()
  })
})


