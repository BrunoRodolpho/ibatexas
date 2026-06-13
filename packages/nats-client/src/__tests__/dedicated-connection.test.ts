// T3-10 — openDedicatedNatsConnection: per-role test-plane credentials.
//
// The journey-test plane carries multiple NATS identities in one process
// (app seed via the singleton; subscribe-only capture seed; publish-only
// trigger seed). These tests pin the contract:
//   1. EXPLICIT-ONLY auth — no creds => throw (never fall back to the env
//      vars getNatsConnection reads, so a capture composed without capture
//      creds can never silently ride the publish-capable app credential).
//   2. credsPath > nkeySeed precedence (same as the singleton's resolver).
//   3. NON-SINGLETON — every call dials a fresh connection and the package
//      singleton is untouched.
//   4. Shared TLS env resolution (NATS_TLS_CA / NATS_TLS_REQUIRED).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { openDedicatedNatsConnection, closeNatsConnection } from "../index.js"

const mockConnect = vi.hoisted(() => vi.fn())
const mockCredsAuthenticator = vi.hoisted(() => vi.fn((_creds?: Uint8Array) => "credsAuth"))
const mockNkeyAuthenticator = vi.hoisted(() => vi.fn((_seed?: Uint8Array) => "nkeyAuth"))

vi.mock("nats", () => {
  mockConnect.mockImplementation(async () => ({
    publish: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
    drain: vi.fn(),
  }))
  return {
    connect: mockConnect,
    credsAuthenticator: mockCredsAuthenticator,
    nkeyAuthenticator: mockNkeyAuthenticator,
  }
})

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string, encoding?: string) => {
    if (path.endsWith(".creds")) return Buffer.from("-- creds --")
    if (path.endsWith(".pem")) {
      return encoding === "utf8" ? "-- pem --" : Buffer.from("-- pem --")
    }
    throw new Error(`unexpected readFile: ${path}`)
  }),
}))

describe("T3-10 openDedicatedNatsConnection", () => {
  beforeEach(async () => {
    await closeNatsConnection()
    vi.clearAllMocks()
    delete process.env.NATS_CREDS_PATH
    delete process.env.NATS_NKEY_SEED
    delete process.env.NATS_TLS_CA
    delete process.env.NATS_TLS_REQUIRED
    delete process.env.NATS_URL
  })

  it("THROWS without explicit credentials — even when the env carries the app seed", async () => {
    process.env.NATS_NKEY_SEED = "SUAPPSEEDFROMENV" // must be IGNORED
    await expect(openDedicatedNatsConnection({})).rejects.toThrow(
      /requires explicit credentials/,
    )
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockNkeyAuthenticator).not.toHaveBeenCalled()
  })

  it("treats empty-string credentials as absent (fail-closed)", async () => {
    await expect(
      openDedicatedNatsConnection({ credsPath: "", nkeySeed: "" }),
    ).rejects.toThrow(/requires explicit credentials/)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it("connects with the GIVEN nkey seed (not the env one)", async () => {
    process.env.NATS_NKEY_SEED = "SUAPPSEEDFROMENV"
    process.env.NATS_URL = "nats://localhost:4223"
    await openDedicatedNatsConnection({ nkeySeed: "SUCAPTURESEED" })
    expect(mockNkeyAuthenticator).toHaveBeenCalledTimes(1)
    const seedBytes = mockNkeyAuthenticator.mock.calls[0]![0]
    expect(seedBytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(seedBytes)).toBe("SUCAPTURESEED")
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: ["nats://localhost:4223"],
        authenticator: "nkeyAuth",
      }),
    )
  })

  it("prefers credsPath over nkeySeed", async () => {
    await openDedicatedNatsConnection({
      credsPath: "/etc/nats/capture.creds",
      nkeySeed: "SUCAPTURESEED",
    })
    expect(mockCredsAuthenticator).toHaveBeenCalledTimes(1)
    expect(mockNkeyAuthenticator).not.toHaveBeenCalled()
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ authenticator: "credsAuth" }),
    )
  })

  it("is NOT a singleton — two calls dial two connections", async () => {
    const a = await openDedicatedNatsConnection({ nkeySeed: "SUSEEDA" })
    const b = await openDedicatedNatsConnection({ nkeySeed: "SUSEEDB" })
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })

  it("honours the shared TLS env resolution (NATS_TLS_CA)", async () => {
    process.env.NATS_TLS_CA = "/etc/nats/ca.pem"
    await openDedicatedNatsConnection({ nkeySeed: "SUCAPTURESEED" })
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ tls: { ca: "-- pem --" } }),
    )
  })
})
