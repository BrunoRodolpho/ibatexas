// Unit tests for WA conversion rate and avg messages-to-checkout in admin analytics summary

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
const mockRedisGet = vi.hoisted(() => vi.fn())

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
    get: mockRedisGet,
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

describe("GET /api/admin/analytics/summary — WA conversion rate", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Default Medusa mocks: empty orders + zero active carts
    mockMedusaAdmin.mockResolvedValue({ orders: [], count: 0 })
  })

  it("computes 40% conversion rate: 5 conversations, 2 orders", async () => {
    // Redis calls (in order): outreach, conversations, wa_orders, avg_messages
    mockRedisGet
      .mockResolvedValueOnce(null)   // outreach:weekly:count
      .mockResolvedValueOnce("5")    // metrics:conversations:daily:{date}
      .mockResolvedValueOnce("2")    // metrics:wa_orders:daily:{date}
      .mockResolvedValueOnce(null)   // metrics:avg_messages_to_checkout

    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] })
    mockMedusaAdmin.mockResolvedValueOnce({ count: 0 })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { waConversionRate: number }
    // 2/5 * 100 = 40%
    expect(body.waConversionRate).toBe(40)
  })

  it("returns 0% when conversations count is zero (no division by zero)", async () => {
    mockRedisGet
      .mockResolvedValueOnce(null)  // outreach:weekly:count
      .mockResolvedValueOnce("0")   // metrics:conversations:daily:{date}
      .mockResolvedValueOnce("3")   // metrics:wa_orders:daily:{date}
      .mockResolvedValueOnce(null)  // metrics:avg_messages_to_checkout

    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] })
    mockMedusaAdmin.mockResolvedValueOnce({ count: 0 })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { waConversionRate: number }
    expect(body.waConversionRate).toBe(0)
  })

  it("returns 0% when conversations key is absent (null from Redis)", async () => {
    mockRedisGet
      .mockResolvedValueOnce(null)  // outreach:weekly:count
      .mockResolvedValueOnce(null)  // metrics:conversations:daily:{date}
      .mockResolvedValueOnce(null)  // metrics:wa_orders:daily:{date}
      .mockResolvedValueOnce(null)  // metrics:avg_messages_to_checkout

    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] })
    mockMedusaAdmin.mockResolvedValueOnce({ count: 0 })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { waConversionRate: number }
    expect(body.waConversionRate).toBe(0)
  })
})

describe("GET /api/admin/analytics/summary — avgMessagesToCheckout", () => {
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

  it("reads avgMessagesToCheckout from Redis and rounds to nearest integer", async () => {
    mockRedisGet
      .mockResolvedValueOnce(null)   // outreach:weekly:count
      .mockResolvedValueOnce(null)   // metrics:conversations:daily:{date}
      .mockResolvedValueOnce(null)   // metrics:wa_orders:daily:{date}
      .mockResolvedValueOnce("7.6")  // metrics:avg_messages_to_checkout

    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] })
    mockMedusaAdmin.mockResolvedValueOnce({ count: 0 })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { avgMessagesToCheckout: number }
    expect(body.avgMessagesToCheckout).toBe(8)
  })

  it("defaults avgMessagesToCheckout to 0 when key is absent", async () => {
    mockRedisGet.mockResolvedValue(null)

    mockMedusaAdmin.mockResolvedValueOnce({ orders: [] })
    mockMedusaAdmin.mockResolvedValueOnce({ count: 0 })

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/analytics/summary",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { avgMessagesToCheckout: number }
    expect(body.avgMessagesToCheckout).toBe(0)
  })
})
