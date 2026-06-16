import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  getNatsConnection,
  publishNatsEvent,
  subscribeNatsEvent,
  setDlqHandler,
  setOutboxWriter,
  closeNatsConnection,
} from "../index.js"

// Mock the nats module with a proper implementation
const mockConnect = vi.hoisted(() => vi.fn())
const mockCredsAuthenticator = vi.hoisted(() => vi.fn(() => "credsAuth"))
const mockNkeyAuthenticator = vi.hoisted(() => vi.fn(() => "nkeyAuth"))
// Phase 1: JetStream client publish (returns a PubAck).
const mockJsPublish = vi.hoisted(() => vi.fn(async () => ({ seq: 1, stream: "IBX_ORDERS", duplicate: false })))

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
    jetstream: vi.fn(() => ({ publish: mockJsPublish })),
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

  // ── Phase 1: durable publish via JetStream (PubAck) ────────────────────────

  it("[Phase 1] publishes via JetStream (PubAck) when NATS_JETSTREAM_ENABLED=true", async () => {
    process.env.NATS_JETSTREAM_ENABLED = "true"
    try {
      await publishNatsEvent("order.placed", { orderId: "o1" })
      expect(mockJsPublish).toHaveBeenCalledWith(
        "ibatexas.order.placed",
        expect.any(Uint8Array),
      )
      // The Core publish path is NOT used when JetStream is enabled + healthy.
      const conn = await getNatsConnection()
      expect(conn.publish).not.toHaveBeenCalled()
    } finally {
      delete process.env.NATS_JETSTREAM_ENABLED
    }
  })

  it("[Phase 1] falls back to Core publish when the JetStream publish fails", async () => {
    process.env.NATS_JETSTREAM_ENABLED = "true"
    mockJsPublish.mockRejectedValueOnce(new Error("no stream matches subject"))
    try {
      await publishNatsEvent("order.placed", { orderId: "o1" })
      // Fallback: the event is still published on Core NATS, never dropped.
      const conn = await getNatsConnection()
      expect(conn.publish).toHaveBeenCalledWith(
        "ibatexas.order.placed",
        expect.any(Uint8Array),
      )
    } finally {
      delete process.env.NATS_JETSTREAM_ENABLED
    }
  })

  it("[Phase 1] uses Core publish (not JetStream) when the flag is off", async () => {
    await publishNatsEvent("order.placed", { orderId: "o1" })
    expect(mockJsPublish).not.toHaveBeenCalled()
    const conn = await getNatsConnection()
    expect(conn.publish).toHaveBeenCalled()
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

  // ── P1-ERR-NATSLOOP — route unhandled subscriber errors to the DLQ ──────────
  it("routes an unhandled subscriber error through the injected DLQ handler", async () => {
    const conn = await getNatsConnection()
    const subscribeSpy = conn.subscribe as ReturnType<typeof vi.fn>
    subscribeSpy.mockReturnValueOnce(oneShotSub(encode({ orderId: "ord_1" }), 5))

    const dlq = vi.fn()
    setDlqHandler(dlq)
    const boom = new Error("handler blew up")
    const handler = vi.fn().mockRejectedValue(boom)

    await subscribeNatsEvent("order.placed", handler)
    await flushAsync()

    expect(handler).toHaveBeenCalledWith({ orderId: "ord_1" })
    expect(dlq).toHaveBeenCalledWith("order.placed", { orderId: "ord_1" }, boom)
    setDlqHandler(() => {}) // reset shared singleton for later tests
  })

  it("does not invoke the DLQ handler when the subscriber succeeds", async () => {
    const conn = await getNatsConnection()
    const subscribeSpy = conn.subscribe as ReturnType<typeof vi.fn>
    subscribeSpy.mockReturnValueOnce(oneShotSub(encode({ orderId: "ord_ok" }), 5))

    const dlq = vi.fn()
    setDlqHandler(dlq)

    await subscribeNatsEvent("order.placed", vi.fn().mockResolvedValue(undefined))
    await flushAsync()

    expect(dlq).not.toHaveBeenCalled()
    setDlqHandler(() => {})
  })

  // ── P1-SCALE-OUTBOXMEM (writer-side cap) ────────────────────────────────────
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

  // ── Outbox retirement (flag-gated): JetStream PubAck replaces the outbox ────

  it("[retirement] bypasses the outbox when JetStream publish succeeds (flag on)", async () => {
    process.env.NATS_JETSTREAM_ENABLED = "true"
    const writer = {
      lPush: vi.fn().mockResolvedValue(1),
      lRem: vi.fn().mockResolvedValue(1),
      lTrim: vi.fn().mockResolvedValue("OK"),
    }
    setOutboxWriter(writer)
    try {
      await publishNatsEvent("order.placed", { orderId: "o1" }) // order.placed is critical
      expect(mockJsPublish).toHaveBeenCalled() // durable via PubAck
      expect(writer.lPush).not.toHaveBeenCalled() // outbox bypassed
      expect(writer.lRem).not.toHaveBeenCalled()
    } finally {
      delete process.env.NATS_JETSTREAM_ENABLED
    }
  })

  it("[retirement] restores the outbox safety net when JetStream publish fails (flag on)", async () => {
    process.env.NATS_JETSTREAM_ENABLED = "true"
    mockJsPublish.mockRejectedValueOnce(new Error("no stream matches subject"))
    const writer = {
      lPush: vi.fn().mockResolvedValue(1),
      lRem: vi.fn().mockResolvedValue(1),
      lTrim: vi.fn().mockResolvedValue("OK"),
    }
    setOutboxWriter(writer)
    try {
      await publishNatsEvent("order.placed", { orderId: "o1" })
      // Fallback: outbox written so outbox-retry can recover, then Core publish.
      expect(writer.lPush).toHaveBeenCalledTimes(1)
      const conn = await getNatsConnection()
      expect(conn.publish).toHaveBeenCalled()
    } finally {
      delete process.env.NATS_JETSTREAM_ENABLED
    }
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


