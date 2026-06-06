import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  getNatsConnection,
  publishNatsEvent,
  subscribeNatsEvent,
  closeNatsConnection,
} from "../index.js"

// Mock the nats module with a proper implementation
const mockConnect = vi.hoisted(() => vi.fn())
const mockCredsAuthenticator = vi.hoisted(() => vi.fn(() => "credsAuth"))
const mockNkeyAuthenticator = vi.hoisted(() => vi.fn(() => "nkeyAuth"))

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

  mockConnect.mockImplementation(async () => mockConnection)

  return {
    connect: mockConnect,
    credsAuthenticator: mockCredsAuthenticator,
    nkeyAuthenticator: mockNkeyAuthenticator,
  }
})

// Mock node:fs/promises so we don't read real files in tests.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string, encoding?: string) => {
    if (path.endsWith(".creds")) {
      return Buffer.from("-- creds file contents --")
    }
    if (path.endsWith(".pem") || path.includes("ca")) {
      return encoding === "utf8" ? "-- pem ca --" : Buffer.from("-- pem ca --")
    }
    throw new Error(`unexpected readFile: ${path}`)
  }),
}))

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

  // ── audit-2026-05-24 P2-4 — queue groups ───────────────────────────────
  // Multi-replica deploys need queue groups so each message is handled by
  // exactly one replica per group (instead of N-fold handler inflation).

  it("[P2-4] subscribeNatsEvent passes queueGroup through as { queue } to NATS", async () => {
    const conn = await getNatsConnection()
    const subscribeSpy = conn.subscribe as ReturnType<typeof vi.fn>
    subscribeSpy.mockClear()

    await subscribeNatsEvent("payment.status_changed", vi.fn(), {
      queueGroup: "defer-resolver",
    })

    expect(subscribeSpy).toHaveBeenCalledWith("ibatexas.payment.status_changed", {
      queue: "defer-resolver",
    })
  })

  it("[P2-4] subscribeNatsEvent omits queue opts when no queueGroup is given", async () => {
    const conn = await getNatsConnection()
    const subscribeSpy = conn.subscribe as ReturnType<typeof vi.fn>
    subscribeSpy.mockClear()

    await subscribeNatsEvent("cart.abandoned", vi.fn())

    // Back-compat: no queueGroup → no second arg. Distinguishes "subscribed
    // without a queue group" from "subscribed to a group named undefined".
    expect(subscribeSpy).toHaveBeenCalledWith("ibatexas.cart.abandoned")
  })

  // ── P2-MEM-NATSPENDING — bounded in-flight backlog ─────────────────────
  const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
  function oneShotSub(bytes: Uint8Array, pending: number) {
    let sent = false
    return {
      unsubscribe: vi.fn(),
      getPending: () => pending,
      [Symbol.asyncIterator]: () => ({
        async next() {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: { data: bytes } }
        },
      }),
    }
  }
  const flushAsync = async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }

  it("[P2-MEM-NATSPENDING] drops + warn-logs a message when pending exceeds the cap", async () => {
    const conn = await getNatsConnection()
    const subscribeSpy = conn.subscribe as ReturnType<typeof vi.fn>
    subscribeSpy.mockReturnValueOnce(oneShotSub(encode({ orderId: "ord_over" }), 10_001))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const handler = vi.fn()

    await subscribeNatsEvent("order.placed", handler)
    await flushAsync()

    expect(handler).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Pending backlog over 10000")
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("order.placed")
    warnSpy.mockRestore()
  })

  it("[P2-MEM-NATSPENDING] processes normally when pending is within the cap", async () => {
    const conn = await getNatsConnection()
    const subscribeSpy = conn.subscribe as ReturnType<typeof vi.fn>
    subscribeSpy.mockReturnValueOnce(oneShotSub(encode({ orderId: "ord_ok" }), 5))
    const handler = vi.fn()

    await subscribeNatsEvent("order.placed", handler)
    await flushAsync()

    expect(handler).toHaveBeenCalledWith({ orderId: "ord_ok" })
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

// ── W4 P0-12: NATS authentication wiring ─────────────────────────────────

describe("NATS Client — P0-12 authentication wiring", () => {
  beforeEach(async () => {
    await closeNatsConnection()
    vi.clearAllMocks()
    delete process.env.NATS_CREDS_PATH
    delete process.env.NATS_NKEY_SEED
    delete process.env.NATS_TLS_CA
    delete process.env.NATS_TLS_REQUIRED
    delete process.env.NODE_ENV
  })

  it("[P0-12] connects without auth when no env vars set (dev default)", async () => {
    await getNatsConnection()
    const opts = mockConnect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts).toBeDefined()
    expect(opts.authenticator).toBeUndefined()
    expect(opts.tls).toBeUndefined()
  })

  it("[P0-12] uses credsAuthenticator when NATS_CREDS_PATH is set", async () => {
    process.env.NATS_CREDS_PATH = "/etc/nats/svc-api.creds"
    await getNatsConnection()
    expect(mockCredsAuthenticator).toHaveBeenCalledTimes(1)
    const opts = mockConnect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.authenticator).toBe("credsAuth")
  })

  it("[P0-12] uses nkeyAuthenticator when only NATS_NKEY_SEED is set", async () => {
    process.env.NATS_NKEY_SEED = "SUABCDEF1234567890"
    await getNatsConnection()
    expect(mockNkeyAuthenticator).toHaveBeenCalledTimes(1)
    const opts = mockConnect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.authenticator).toBe("nkeyAuth")
  })

  it("[P0-12] CREDS_PATH takes precedence over NKEY_SEED", async () => {
    process.env.NATS_CREDS_PATH = "/etc/nats/api.creds"
    process.env.NATS_NKEY_SEED = "SUEXTRA"
    await getNatsConnection()
    expect(mockCredsAuthenticator).toHaveBeenCalledTimes(1)
    expect(mockNkeyAuthenticator).not.toHaveBeenCalled()
  })

  it("[P0-12] wires CA when NATS_TLS_CA is set", async () => {
    process.env.NATS_TLS_CA = "/etc/nats/ca.pem"
    await getNatsConnection()
    const opts = mockConnect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.tls).toEqual({ ca: "-- pem ca --" })
  })

  it("[P0-12] wires empty TLS opts when NATS_TLS_REQUIRED=true (require TLS)", async () => {
    process.env.NATS_TLS_REQUIRED = "true"
    await getNatsConnection()
    const opts = mockConnect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.tls).toEqual({})
  })

  it("[P0-12 / NEW-P0-X3] THROWS in production when no auth + no TLS (fail-closed)", async () => {
    // Pre-NEW-P0-X3 the function emitted a console.error and proceeded —
    // leaving audit PII broadcastable to anyone reaching the NATS port.
    // Post-fix the function throws and the process exits non-zero at boot
    // so ops must provision creds before deploying.
    process.env.NODE_ENV = "production"
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await expect(getNatsConnection()).rejects.toThrow(
        /production requires NATS auth/i,
      )
      const messages = spy.mock.calls
        .map((c) => (c[0] as string) ?? "")
        .join("\n")
      // The breadcrumb is still written to stderr immediately before throw.
      expect(messages).toContain("NATS-AUTH-REQUIREMENTS")
    } finally {
      spy.mockRestore()
    }
  })

  it("[P0-12] does NOT emit production warning when auth is configured", async () => {
    process.env.NODE_ENV = "production"
    process.env.NATS_CREDS_PATH = "/etc/nats/api.creds"
    process.env.NATS_TLS_CA = "/etc/nats/ca.pem"
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await getNatsConnection()
      const messages = spy.mock.calls
        .map((c) => (c[0] as string) ?? "")
        .join("\n")
      expect(messages).not.toContain("NATS connection has no authentication")
    } finally {
      spy.mockRestore()
    }
  })
})


