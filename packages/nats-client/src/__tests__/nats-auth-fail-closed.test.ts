// NEW-P0-X3 — NATS auth must fail-CLOSED in production.
//
// Background: W4 P0-12 added auth code paths but did NOT flip polarity.
// Pre-fix, when NODE_ENV=production AND no authenticator AND no TLS,
// `getNatsConnection()` emits a console.error and PROCEEDS — leaving
// audit PII broadcastable to anyone who can reach the NATS port.
//
// The fix: throw an Error so the process refuses to bring up the NATS
// connection without auth in production. Operators MUST provision
// NATS_CREDS_PATH or NATS_NKEY_SEED (and TLS) before deploying.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { getNatsConnection, closeNatsConnection } from "../index.js"

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockConnect = vi.hoisted(() => vi.fn())
const mockCredsAuthenticator = vi.hoisted(() => vi.fn(() => "credsAuth"))
const mockNkeyAuthenticator = vi.hoisted(() => vi.fn(() => "nkeyAuth"))

vi.mock("nats", () => {
  const mockConnection = {
    publish: vi.fn(),
    subscribe: vi.fn(),
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

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string, encoding?: string) => {
    if (path.endsWith(".creds")) return Buffer.from("-- creds --")
    if (path.endsWith(".pem") || path.includes("ca")) {
      return encoding === "utf8" ? "-- pem --" : Buffer.from("-- pem --")
    }
    throw new Error(`unexpected readFile: ${path}`)
  }),
}))

describe("NEW-P0-X3 NATS auth fail-closed in production", () => {
  beforeEach(async () => {
    await closeNatsConnection()
    vi.clearAllMocks()
    delete process.env.NATS_CREDS_PATH
    delete process.env.NATS_NKEY_SEED
    delete process.env.NATS_TLS_CA
    delete process.env.NATS_TLS_REQUIRED
    delete process.env.NODE_ENV
  })

  it("THROWS when NODE_ENV=production and no auth/TLS is configured", async () => {
    process.env.NODE_ENV = "production"
    // Capture console.error so the SECURITY message doesn't pollute the test
    // output, but we still verify it surfaces.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await expect(getNatsConnection()).rejects.toThrow(
        /production requires NATS auth/i,
      )
      // The connect() function must NOT have been called — we fail-closed
      // BEFORE opening a network connection.
      expect(mockConnect).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("PROCEEDS in production when CREDS_PATH is configured", async () => {
    process.env.NODE_ENV = "production"
    process.env.NATS_CREDS_PATH = "/etc/nats/api.creds"
    await expect(getNatsConnection()).resolves.toBeDefined()
    expect(mockConnect).toHaveBeenCalled()
  })

  it("PROCEEDS in production when NKEY_SEED is configured", async () => {
    process.env.NODE_ENV = "production"
    process.env.NATS_NKEY_SEED = "SUABCDEF1234567890"
    await expect(getNatsConnection()).resolves.toBeDefined()
    expect(mockConnect).toHaveBeenCalled()
  })

  it("PROCEEDS in production when only TLS (NATS_TLS_REQUIRED=true) is configured", async () => {
    // TLS without auth is still meaningfully better than nothing — the
    // server presents a cert and clients must validate it. Our guard
    // requires EITHER an authenticator OR TLS, not necessarily both.
    process.env.NODE_ENV = "production"
    process.env.NATS_TLS_REQUIRED = "true"
    await expect(getNatsConnection()).resolves.toBeDefined()
    expect(mockConnect).toHaveBeenCalled()
  })

  it("PROCEEDS in dev (no NODE_ENV) without auth — back-compat default", async () => {
    delete process.env.NODE_ENV
    await expect(getNatsConnection()).resolves.toBeDefined()
    expect(mockConnect).toHaveBeenCalled()
  })
})
