// Unit tests for GET /api/admin/analytics/summary

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())

vi.mock("../routes/admin/_shared.js", () => ({
  medusaAdmin: mockMedusaAdmin,
  medusaStore: vi.fn(async () => ({})),
}))

vi.mock("@ibatexas/domain", () => ({
  createReservationService: () => ({
    findAll: vi.fn(async () => []),
    findConfirmedForDate: vi.fn(async () => []),
    checkAvailability: vi.fn(async () => []),
    transition: vi.fn(async () => {}),
    getTodaySummary: vi.fn(async () => ({
      total: 0, confirmed: 0, seated: 0, completed: 0, cancelled: 0, noShow: 0, covers: 0,
    })),
  }),
  createTableService: () => ({
    listAll: vi.fn(async () => []),
    upsert: vi.fn(async (data: { number: string }) => ({ id: "t1", ...data })),
  }),
  createDeliveryZoneService: () => ({
    listAll: vi.fn(async () => []),
  }),
  prisma: {
    review: { findMany: vi.fn(), count: vi.fn() },
    customer: { count: vi.fn(async () => 0) },
  },
}))

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    get: vi.fn(async () => null),
  })),
  rk: vi.fn((key: string) => `test:${key}`),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}))

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  process.env.ADMIN_API_KEY = "test-admin-key"
  process.env.MEDUSA_ADMIN_URL = "http://localhost:9000"
  process.env.MEDUSA_API_KEY = "test-medusa-key"

  const { adminRoutes } = await import("../routes/admin/index.js")

  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(adminRoutes)
  await app.ready()
  return app
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/analytics/summary — returns analytics data", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns ordersToday, revenueToday, averageOrderValue, and activeCarts", async () => {
    // First call: orders list
    mockMedusaAdmin.mockResolvedValueOnce({
      orders: [
        { id: "order_01", total: 8900, status: "completed" },
        { id: "order_02", total: 5500, status: "completed" },
      ],
    })
    // Second call: active carts (pending orders count)
    mockMedusaAdmin.mockResolvedValueOnce({
      count: 3,
    })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, number>
    expect(body.ordersToday).toBe(2)
    expect(body.revenueToday).toBe(14400)
    expect(body.aov).toBe(7200)
    expect(body.activeCarts).toBe(3)
    expect(body.newCustomers30d).toBe(0)
    expect(body.outreachWeekly).toBe(0)
    expect(body.waConversionRate).toBe(0)
    expect(body.avgMessagesToCheckout).toBe(0)
  })

  it("returns zeros when Medusa is unavailable", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("Medusa not running"))

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, number>
    expect(body.ordersToday).toBe(0)
    expect(body.revenueToday).toBe(0)
    expect(body.aov).toBe(0)
    expect(body.activeCarts).toBe(0)
    expect(body.newCustomers30d).toBe(0)
    expect(body.outreachWeekly).toBe(0)
    expect(body.waConversionRate).toBe(0)
    expect(body.avgMessagesToCheckout).toBe(0)
  })

  it("computes aov as 0 when there are no orders", async () => {
    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] })
    mockMedusaAdmin.mockResolvedValueOnce({ count: 0 })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { aov: number }
    expect(body.aov).toBe(0)
  })
})

describe("GET /api/admin/analytics/summary — returns 401 without admin auth", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  it("returns 401 when x-admin-key header is missing", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 401 when x-admin-key header is wrong", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "wrong-key" },
    })

    expect(res.statusCode).toBe(401)
  })
})
