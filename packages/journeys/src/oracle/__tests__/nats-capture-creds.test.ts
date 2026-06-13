// T3-10 — connectNatsCapture per-role credential selection.
//
// On an authed test stack the harness process env carries BOTH the
// publish-capable app seed (NATS_NKEY_SEED, loaded from .env.test for the
// SUT-facing clients) AND the subscribe-only capture seed
// (IBX_TEST_NATS_CAPTURE_NKEY_SEED). These tests pin that the capture:
//   1. PREFERS the capture credential — opens a DEDICATED connection via
//      openDedicatedNatsConnection (never the publish-capable singleton);
//   2. routes close() to that dedicated connection (singleton untouched);
//   3. falls back to the env-driven singleton ONLY when no capture
//      credential is provisioned (unit doubles / pre-T3-10 stacks);
//   4. supports the .creds-file variant with precedence over the seed.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { connectNatsCapture } from "../nats-capture.js"

const dedicatedClose = vi.hoisted(() => vi.fn(async () => {}))
const mockOpenDedicated = vi.hoisted(() => vi.fn())
const mockGetSingleton = vi.hoisted(() => vi.fn())
const mockCloseSingleton = vi.hoisted(() => vi.fn(async () => {}))

function connectionDouble(close?: () => Promise<void>) {
  return {
    subscribe: vi.fn(() => ({
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    })),
    drain: vi.fn(async () => {}),
    ...(close ? { close } : {}),
  }
}

vi.mock("@ibatexas/nats-client", () => ({
  openDedicatedNatsConnection: mockOpenDedicated,
  getNatsConnection: mockGetSingleton,
  closeNatsConnection: mockCloseSingleton,
}))

describe("T3-10 connectNatsCapture credential selection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.IBX_TEST_NATS_CAPTURE_NKEY_SEED
    delete process.env.IBX_TEST_NATS_CAPTURE_CREDS_PATH
    mockOpenDedicated.mockImplementation(async () => connectionDouble(dedicatedClose))
    mockGetSingleton.mockImplementation(async () => connectionDouble())
  })

  it("prefers the capture seed: dedicated connection, singleton NEVER dialed", async () => {
    process.env.IBX_TEST_NATS_CAPTURE_NKEY_SEED = "SUCAPTURESEED"
    const capture = await connectNatsCapture()
    expect(mockOpenDedicated).toHaveBeenCalledTimes(1)
    expect(mockOpenDedicated).toHaveBeenCalledWith({ nkeySeed: "SUCAPTURESEED" })
    expect(mockGetSingleton).not.toHaveBeenCalled()

    // close() tears down the DEDICATED connection, not the package singleton.
    await capture.close()
    expect(dedicatedClose).toHaveBeenCalledTimes(1)
    expect(mockCloseSingleton).not.toHaveBeenCalled()
  })

  it("supports the .creds variant and passes it through with precedence", async () => {
    process.env.IBX_TEST_NATS_CAPTURE_CREDS_PATH = "/etc/nats/capture.creds"
    process.env.IBX_TEST_NATS_CAPTURE_NKEY_SEED = "SUCAPTURESEED"
    await connectNatsCapture()
    expect(mockOpenDedicated).toHaveBeenCalledWith({
      credsPath: "/etc/nats/capture.creds",
      nkeySeed: "SUCAPTURESEED",
    })
    expect(mockGetSingleton).not.toHaveBeenCalled()
  })

  it("falls back to the singleton when no capture credential is provisioned", async () => {
    const capture = await connectNatsCapture()
    expect(mockGetSingleton).toHaveBeenCalledTimes(1)
    expect(mockOpenDedicated).not.toHaveBeenCalled()
    await capture.close()
    expect(mockCloseSingleton).toHaveBeenCalledTimes(1)
  })

  it("treats an empty-string capture seed as absent (no half-configured auth)", async () => {
    process.env.IBX_TEST_NATS_CAPTURE_NKEY_SEED = ""
    await connectNatsCapture()
    expect(mockOpenDedicated).not.toHaveBeenCalled()
    expect(mockGetSingleton).toHaveBeenCalledTimes(1)
  })
})
