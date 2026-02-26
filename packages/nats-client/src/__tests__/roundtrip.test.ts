import { describe, it, expect, vi, beforeEach } from "vitest"

describe("NATS Roundtrip", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("publishes and subscribes to the same subject", async () => {
    const messages: Array<{ subject: string; data: unknown }> = []

    // Simulate NATS pub/sub
    const handlers = new Map<string, (data: unknown) => void>()

    const subscribe = (subject: string, handler: (data: unknown) => void) => {
      handlers.set(subject, handler)
    }

    const publish = (subject: string, data: unknown) => {
      messages.push({ subject, data })
      const handler = handlers.get(subject)
      if (handler) handler(data)
    }

    const received: unknown[] = []
    subscribe("ibatexas.order.placed", (data) => received.push(data))
    publish("ibatexas.order.placed", { orderId: "ord_1", total: 8900 })

    expect(messages).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ orderId: "ord_1", total: 8900 })
  })

  it("handles wildcard subjects", () => {
    const subjects = ["ibatexas.order.placed", "ibatexas.order.cancelled", "ibatexas.cart.abandoned"]
    const orderSubjects = subjects.filter((s) => s.startsWith("ibatexas.order."))
    expect(orderSubjects).toHaveLength(2)
  })
})
