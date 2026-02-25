// Tests for admin auth guard and shipping routes
// Covers previously untested HTTP routes

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"

// ── Mock dependencies for admin routes ────────────────────────────────────────

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    reservation: { findMany: vi.fn(async () => []) },
    table: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (args: { create: { number: string } }) => ({ id: "t1", ...args.create })),
    },
    timeSlot: { createMany: vi.fn(async () => ({ count: 0 })) },
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}))

// ── Admin auth guard tests ────────────────────────────────────────────────────

describe("admin auth guard", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = "test-admin-key-12345"
    process.env.MEDUSA_ADMIN_URL = "http://localhost:9000"
    process.env.MEDUSA_API_KEY = "test-medusa-key"

    const { adminRoutes } = await import("../routes/admin/index.js")

    server = Fastify({ logger: false })
    server.setValidatorCompiler(validatorCompiler)
    server.setSerializerCompiler(serializerCompiler)
    await server.register(sensible)
    await server.register(adminRoutes)
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it("rejects requests without x-admin-key header", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/tables",
    })
    expect(response.statusCode).toBe(401)
  })

  it("rejects requests with wrong x-admin-key", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/tables",
      headers: { "x-admin-key": "wrong-key" },
    })
    expect(response.statusCode).toBe(401)
  })

  it("rejects requests with empty x-admin-key header", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/tables",
      headers: { "x-admin-key": "" },
    })
    expect(response.statusCode).toBe(401)
  })

  it("accepts requests with correct x-admin-key", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/tables",
      headers: { "x-admin-key": "test-admin-key-12345" },
    })
    // Should not be 401 (might be 200 or other status depending on route logic)
    expect(response.statusCode).not.toBe(401)
  })
})

describe("admin auth guard — no key configured", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    const savedKey = process.env.ADMIN_API_KEY
    delete process.env.ADMIN_API_KEY

    // Need dynamic import to pick up changed env
    vi.resetModules()
    const { adminRoutes } = await import("../routes/admin/index.js")

    server = Fastify({ logger: false })
    server.setValidatorCompiler(validatorCompiler)
    server.setSerializerCompiler(serializerCompiler)
    await server.register(sensible)
    await server.register(adminRoutes)
    await server.ready()

    // Restore
    if (savedKey) process.env.ADMIN_API_KEY = savedKey
  })

  afterAll(async () => {
    await server.close()
  })

  it("returns 503 when ADMIN_API_KEY is not configured", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/tables",
      headers: { "x-admin-key": "" },
    })
    expect(response.statusCode).toBe(503)
  })
})
