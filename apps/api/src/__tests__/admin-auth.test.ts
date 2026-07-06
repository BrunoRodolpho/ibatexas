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
  // AUT-038 + AUT-007 — the OWNER-gated admin staff routes construct this at
  // server onReady; the full-admin-server build needs it present in the mock.
  createStaffCommandService: () => ({}),
  FROZEN_CAUSES: ["empty_completion", "whitespace_only", "send_failed", "retry_exhausted", "timeout"],
  createReservationService: () => ({
    findAll: vi.fn(async () => []),
    findConfirmedForDate: vi.fn(async () => []),
    checkAvailability: vi.fn(async () => []),
    transition: vi.fn(async () => {}),
    transitionFromEnvelope: vi.fn(async () => ({ decision: { kind: "EXECUTE", basis: [] }, result: undefined })),
    listAll: vi.fn(async () => ({ reservations: [], total: 0 })),
    getTodaySummary: vi.fn(async () => ({ total: 0, confirmed: 0, seated: 0, completed: 0, cancelled: 0, noShow: 0, covers: 0 })),
  }),
  createTableService: () => ({
    listAll: vi.fn(async () => []),
    upsert: vi.fn(async (data: { number: string }) => ({ id: "t1", ...data })),
  }),
  createDeliveryZoneService: () => ({
    listAll: vi.fn(async () => []),
  }),
  createScheduleService: () => ({
    getSchedule: vi.fn(async () => ({ days: {} })),
    updateSchedule: vi.fn(async () => ({})),
  }),
  createOrderCommandService: () => ({
    create: vi.fn(),
    reconcileStatus: vi.fn(async () => ({ success: true })),
    transitionStatus: vi.fn(async () => ({ version: 1, previousStatus: "pending", newStatus: "pending" })),
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 1, previousStatus: "pending", newStatus: "pending" },
    })),
  }),
  createOrderQueryService: () => ({
    list: vi.fn(async () => ({ orders: [], count: 0 })),
    listAll: vi.fn(async () => ({ orders: [], count: 0 })),
    getById: vi.fn(async () => null),
  }),
  createPaymentCommandService: () => ({
    create: vi.fn(),
    transitionStatus: vi.fn(async () => ({ id: "pay_01", version: 1 })),
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 1, previousStatus: "paid", newStatus: "paid" },
    })),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: vi.fn(async () => ({ payments: [], count: 0 })),
    getActiveByOrderId: vi.fn(async () => null),
  }),
  createOrderEventLogService: () => ({
    append: vi.fn(async () => undefined),
  }),
  prisma: {
    reservation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    review: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    customerOrderItem: { findMany: vi.fn(async () => []) },
    conversationMessage: { count: vi.fn(async () => 0) },
    orderProjection: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    customer: { findMany: vi.fn(async () => []) },
    reservationTable: { findMany: vi.fn(async () => []) },
    payment: { update: vi.fn(async () => ({})) },
    orderNote: { create: vi.fn(async () => ({ id: "n1", createdAt: new Date(), content: "" })), findMany: vi.fn(async () => []) },
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}))

vi.mock("../routes/admin/_shared.js", () => ({
  medusaAdmin: vi.fn(async () => ({})),
  medusaStore: vi.fn(async () => ({})),
}))

// ── Admin auth guard tests ────────────────────────────────────────────────────

describe("admin auth guard", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = "test-admin-key-12345"
    process.env.MEDUSA_ADMIN_URL = "http://localhost:9000"
    process.env.MEDUSA_ADMIN_EMAIL = "test@example.com"
    process.env.MEDUSA_ADMIN_PASSWORD = "test-password"

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

    // vi.resetModules() gives a fresh @ibatexas/audit-sink module instance,
    // dropping the no-op deps the global setup.ts wired into the original
    // instance. orders.ts calls getAuditSink() in its onReady hook, which is
    // fail-closed and throws AuditSinkNotInitializedError until deps are set.
    // Re-wire a no-op sink on the fresh instance before registering routes
    // (idiom: __resetAuditSink() + __setAuditSinkDependencies(...), see setup.ts).
    const { __resetAuditSink, __setAuditSinkDependencies } = await import(
      "@ibatexas/audit-sink"
    )
    __resetAuditSink()
    __setAuditSinkDependencies({
      spillStorage: {
        async append() {
          /* no-op */
        },
        async *readAll() {
          /* yields nothing */
        },
        async ack() {
          /* no-op */
        },
      },
      postgresWriter: {
        async insertAudit() {
          /* no-op */
        },
      },
      natsPublisher: {
        async publish() {
          /* no-op */
        },
      },
      redactor: {
        redact(record) {
          return record
        },
      },
      logger: {
        warn() {
          /* no-op */
        },
        error() {
          /* no-op */
        },
      },
    })

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
