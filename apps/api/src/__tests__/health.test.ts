// Integration tests for health route
// GET /health — returns status, version, timestamp

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { healthRoutes } from "../routes/health.js"

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

  it("returns 200 with status ok", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe("ok")
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
})
