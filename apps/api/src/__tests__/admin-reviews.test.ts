// Unit tests for GET /api/admin/reviews

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockReviewFindMany = vi.hoisted(() => vi.fn())
const mockReviewCount = vi.hoisted(() => vi.fn())

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
  createReviewService: vi.fn(),
  createScheduleService: () => ({
    getSchedule: vi.fn(async () => ({ days: {} })),
    updateSchedule: vi.fn(async () => ({})),
  }),
  createOrderCommandService: () => ({
    create: vi.fn(),
    reconcileStatus: vi.fn(async () => ({ success: true })),
  }),
  createOrderQueryService: () => ({
    list: vi.fn(async () => ({ orders: [], count: 0 })),
    getById: vi.fn(async () => null),
  }),
  createPaymentCommandService: () => ({
    create: vi.fn(),
    transitionStatus: vi.fn(async () => ({ id: "pay_01", version: 1 })),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: vi.fn(async () => []),
    getActiveByOrderId: vi.fn(async () => null),
  }),
  prisma: {
    review: {
      findMany: mockReviewFindMany,
      count: mockReviewCount,
    },
    reservation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    customerOrderItem: { findMany: vi.fn(async () => []) },
    conversationMessage: { count: vi.fn(async () => 0) },
    orderProjection: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}))

vi.mock("../routes/admin/_shared.js", () => ({
  medusaAdmin: vi.fn(async () => ({})),
  medusaStore: vi.fn(async () => ({})),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeReviewRow(overrides: Partial<{
  id: string
  orderId: string
  productId: string | null
  customerId: string
  rating: number
  comment: string | null
  channel: string
  createdAt: Date
  customer: { id: string; name: string; phone: string | null }
}> = {}) {
  return {
    id: "rev_01",
    orderId: "order_01",
    productId: "prod_01",
    customerId: "cust_01",
    rating: 5,
    comment: "Ótimo churrasco!",
    channel: "whatsapp",
    createdAt: new Date("2026-03-01T12:00:00.000Z"),
    customer: { id: "cust_01", name: "João Silva", phone: "+5511999990001" },
    ...overrides,
  }
}

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  process.env.ADMIN_API_KEY = "test-admin-key"
  process.env.MEDUSA_ADMIN_URL = "http://localhost:9000"
  process.env.MEDUSA_ADMIN_EMAIL = "test@example.com"
  process.env.MEDUSA_ADMIN_PASSWORD = "test-password"

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

describe("GET /api/admin/reviews — returns reviews list", () => {
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

  it("returns reviews with correct response shape", async () => {
    mockReviewFindMany.mockResolvedValue([makeReviewRow()])
    mockReviewCount.mockResolvedValue(1)

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      reviews: {
        id: string
        orderId: string
        productId: string | null
        customerId: string
        customerPhone: string | null
        rating: number
        comment: string | null
        channel: string
        createdAt: string
      }[]
      total: number
    }

    expect(body.total).toBe(1)
    expect(body.reviews).toHaveLength(1)

    const review = body.reviews[0]
    expect(review.id).toBe("rev_01")
    expect(review.orderId).toBe("order_01")
    expect(review.productId).toBe("prod_01")
    expect(review.customerId).toBe("cust_01")
    expect(review.customerPhone).toBe("****0001")
    expect(review.rating).toBe(5)
    expect(review.comment).toBe("Ótimo churrasco!")
    expect(review.channel).toBe("whatsapp")
    expect(review.createdAt).toBe("2026-03-01T12:00:00.000Z")
  })

  it("returns customerPhone as null when customer has no phone", async () => {
    mockReviewFindMany.mockResolvedValue([
      makeReviewRow({ customer: { id: "cust_02", name: "Ana", phone: null } }),
    ])
    mockReviewCount.mockResolvedValue(1)

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { reviews: { customerPhone: string | null }[] }
    expect(body.reviews[0].customerPhone).toBeNull()
  })

  it("returns empty list when there are no reviews", async () => {
    mockReviewFindMany.mockResolvedValue([])
    mockReviewCount.mockResolvedValue(0)

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { reviews: unknown[]; total: number }
    expect(body.reviews).toHaveLength(0)
    expect(body.total).toBe(0)
  })
})

describe("GET /api/admin/reviews — filters by rating parameter", () => {
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

  it("passes rating filter to Prisma where clause", async () => {
    mockReviewFindMany.mockResolvedValue([makeReviewRow({ rating: 4 })])
    mockReviewCount.mockResolvedValue(1)

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews?rating=4",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)

    expect(mockReviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ rating: 4 }),
      }),
    )
    expect(mockReviewCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ rating: 4 }),
      }),
    )
  })

  it("passes productId filter to Prisma where clause", async () => {
    mockReviewFindMany.mockResolvedValue([makeReviewRow({ productId: "prod_99" })])
    mockReviewCount.mockResolvedValue(1)

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews?productId=prod_99",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(200)

    expect(mockReviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productId: "prod_99" }),
      }),
    )
  })

  it("does not include rating in where clause when not specified", async () => {
    mockReviewFindMany.mockResolvedValue([])
    mockReviewCount.mockResolvedValue(0)

    await server.inject({
      method: "GET",
      url: "/api/admin/reviews",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(mockReviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ rating: expect.anything() }),
      }),
    )
  })

  it("returns 400 for invalid rating value (0 is below min)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews?rating=0",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(400)
  })

  it("returns 400 for invalid rating value (6 is above max)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews?rating=6",
      headers: { "x-admin-key": "test-admin-key" },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("GET /api/admin/reviews — returns 401 without admin auth", () => {
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
      url: "/api/admin/reviews",
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 401 when x-admin-key header is wrong", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/reviews",
      headers: { "x-admin-key": "not-the-right-key" },
    })

    expect(res.statusCode).toBe(401)
  })
})
