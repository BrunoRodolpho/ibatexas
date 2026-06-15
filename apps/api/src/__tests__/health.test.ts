// Integration tests for health route
// GET /health — returns status, version, timestamp

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { healthRoutes } from "../routes/health.js"

// Mock external dependencies so health checks pass in unit tests
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    ping: vi.fn(async () => "PONG"),
  })),
}))

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  getNatsConnection: vi.fn(async () => ({
    isClosed: vi.fn(() => false),
  })),
}))

// Mock global fetch for Typesense health check
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("GET /health", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = Fastify({ logger: false })
    await server.register(healthRoutes)
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it("returns 200 with status healthy when all dependencies are up", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe("healthy")
    expect(body.checks).toEqual({
      redis: "ok",
      postgres: "ok",
      nats: "ok",
      typesense: "ok",
    })
  })

  it("includes a version string", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    const body = response.json()
    expect(body.version).toBeDefined()
    expect(typeof body.version).toBe("string")
    // version should look like semver
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("includes an ISO 8601 timestamp", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    const body = response.json()
    expect(body.timestamp).toBeDefined()
    // Should be valid ISO date
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })

  it("returns 503 when critical dependency fails", async () => {
    // Make Redis fail
    const { getRedisClient } = await import("@ibatexas/tools")
    vi.mocked(getRedisClient).mockRejectedValueOnce(new Error("Redis down"))

    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(503)
    const body = response.json()
    expect(body.status).toBe("unhealthy")
    expect(body.checks.redis).toBe("fail")
  })

  it("returns 200 with degraded when non-critical dependency fails", async () => {
    // Make Typesense fail by mocking fetch to reject
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("Typesense down"))

    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe("degraded")
    expect(body.checks.typesense).toBe("fail")
    // Critical deps should still be ok
    expect(body.checks.redis).toBe("ok")
    expect(body.checks.postgres).toBe("ok")
  })

  // ── testFingerprint (T1a-10 environment handshake, D-010) ──────────────────
  // Present ONLY when IBX_TEST_FINGERPRINT is set in the process env (the
  // test profile sets it; dev/prod never do). Value = the env var's value.
  describe("testFingerprint", () => {
    const originalFingerprint = process.env.IBX_TEST_FINGERPRINT

    afterEach(() => {
      if (originalFingerprint === undefined) {
        delete process.env.IBX_TEST_FINGERPRINT
      } else {
        process.env.IBX_TEST_FINGERPRINT = originalFingerprint
      }
    })

    it("is absent when IBX_TEST_FINGERPRINT is not set", async () => {
      delete process.env.IBX_TEST_FINGERPRINT

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(200)
      expect(response.json()).not.toHaveProperty("testFingerprint")
    })

    it("is absent when IBX_TEST_FINGERPRINT is an empty string", async () => {
      process.env.IBX_TEST_FINGERPRINT = ""

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(200)
      expect(response.json()).not.toHaveProperty("testFingerprint")
    })

    it("exposes the env var's value when IBX_TEST_FINGERPRINT is set", async () => {
      process.env.IBX_TEST_FINGERPRINT = "test-fp-t1a10-handshake"

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(200)
      expect(response.json().testFingerprint).toBe("test-fp-t1a10-handshake")
    })

    it("is present even on a 503 unhealthy response (identity, not health)", async () => {
      process.env.IBX_TEST_FINGERPRINT = "test-fp-unhealthy"
      const { getRedisClient } = await import("@ibatexas/tools")
      vi.mocked(getRedisClient).mockRejectedValueOnce(new Error("Redis down"))

      const response = await server.inject({ method: "GET", url: "/health" })

      expect(response.statusCode).toBe(503)
      expect(response.json().testFingerprint).toBe("test-fp-unhealthy")
    })
  })
})
