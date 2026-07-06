// Admin table + time-slot routes (OPS-018 + OPS-019).
//
// Pins: manager-gating on every mutation, pt-BR error mapping for the typed
// service errors (409 duplicate / 404 not-found / 400 bad range), soft-delete
// routing through update(active:false), and that the generator body is passed
// straight through to the domain service.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod"
import type { FastifyInstance } from "fastify"

// ── Hoisted service mocks + typed error classes ──────────────────────────────

const mockListAll = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockGenerate = vi.hoisted(() => vi.fn())

const { DuplicateTableNumberError, TableNotFoundError, TableHasFutureReservationsError } =
  vi.hoisted(() => {
    class DuplicateTableNumberError extends Error {
      number: string
      constructor(n: string) {
        super(`dup ${n}`)
        this.name = "DuplicateTableNumberError"
        this.number = n
      }
    }
    class TableNotFoundError extends Error {
      id: string
      constructor(id: string) {
        super(`not found ${id}`)
        this.name = "TableNotFoundError"
        this.id = id
      }
    }
    class TableHasFutureReservationsError extends Error {
      id: string
      count: number
      constructor(id: string, count: number) {
        super(`blocked ${id} ${count}`)
        this.name = "TableHasFutureReservationsError"
        this.id = id
        this.count = count
      }
    }
    return { DuplicateTableNumberError, TableNotFoundError, TableHasFutureReservationsError }
  })

vi.mock("@ibatexas/domain", () => ({
  createTableService: () => ({
    listAll: mockListAll,
    create: mockCreate,
    update: mockUpdate,
    generateTimeSlots: mockGenerate,
  }),
  DuplicateTableNumberError,
  TableNotFoundError,
  TableHasFutureReservationsError,
}))

// Faithful-enough stand-in for the real gate: MANAGER/OWNER pass, everyone
// else gets the real 403. The middleware's own logic is covered by
// staff-middleware.test.ts; here we only assert the ROUTE is gated.
vi.mock("../middleware/staff-auth.js", () => ({
  requireManagerRole: async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const role = req.headers["x-staff-role"] as string | undefined
    if (role === "MANAGER" || role === "OWNER") {
      ;(req as unknown as { staffId: string; staffRole: string }).staffId = "staff_test"
      ;(req as unknown as { staffId: string; staffRole: string }).staffRole = role
      return
    }
    return reply.code(403).send({ error: "Acesso restrito a gerentes." })
  },
}))

const MGR = { "x-staff-role": "MANAGER" } as const

async function buildTestServer(): Promise<FastifyInstance> {
  const { tableRoutes } = await import("../routes/admin/tables.js")
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(tableRoutes)
  await app.ready()
  return app
}

describe("Admin table + time-slot routes", () => {
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

  // ── GET /api/admin/tables ──────────────────────────────────────────────────

  it("GET lists tables", async () => {
    mockListAll.mockResolvedValueOnce([{ id: "t1", number: "1" }])
    const res = await server.inject({ method: "GET", url: "/api/admin/tables" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ tables: [{ id: "t1", number: "1" }] })
  })

  // ── POST /api/admin/tables ─────────────────────────────────────────────────

  const validCreate = { number: "12", capacity: 4, location: "indoor" }

  it("POST create is manager-gated (403 without role)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/tables",
      payload: validCreate,
    })
    expect(res.statusCode).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("POST create returns 201 with the created table", async () => {
    mockCreate.mockResolvedValueOnce({ id: "t9", ...validCreate, accessible: false, active: true })
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/tables",
      headers: MGR,
      payload: validCreate,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().table.id).toBe("t9")
  })

  it("POST create rejects capacity <= 0 with 400 (zod)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/tables",
      headers: MGR,
      payload: { number: "12", capacity: 0, location: "indoor" },
    })
    expect(res.statusCode).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("POST create rejects an unknown location with 400 (zod)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/tables",
      headers: MGR,
      payload: { number: "12", capacity: 4, location: "rooftop" },
    })
    expect(res.statusCode).toBe(400)
  })

  it("POST create maps a duplicate number to 409 pt-BR", async () => {
    mockCreate.mockRejectedValueOnce(new DuplicateTableNumberError("12"))
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/tables",
      headers: MGR,
      payload: validCreate,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain("12")
  })

  // ── PATCH /api/admin/tables/:id ────────────────────────────────────────────

  it("PATCH is manager-gated (403 without role)", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/tables/t1",
      payload: { capacity: 6 },
    })
    expect(res.statusCode).toBe(403)
  })

  it("PATCH applies a partial update", async () => {
    mockUpdate.mockResolvedValueOnce({ id: "t1", capacity: 6 })
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/tables/t1",
      headers: MGR,
      payload: { capacity: 6 },
    })
    expect(res.statusCode).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith("t1", { capacity: 6 })
  })

  it("PATCH rejects an empty body with 400", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/tables/t1",
      headers: MGR,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("PATCH maps not-found to 404 pt-BR", async () => {
    mockUpdate.mockRejectedValueOnce(new TableNotFoundError("missing"))
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/tables/missing",
      headers: MGR,
      payload: { active: true },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("Mesa não encontrada.")
  })

  it("PATCH maps a duplicate renamed number to 409", async () => {
    mockUpdate.mockRejectedValueOnce(new DuplicateTableNumberError("7"))
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/tables/t1",
      headers: MGR,
      payload: { number: "7" },
    })
    expect(res.statusCode).toBe(409)
  })

  // ── DELETE /api/admin/tables/:id (soft-deactivate) ─────────────────────────

  it("DELETE is manager-gated (403 without role)", async () => {
    const res = await server.inject({ method: "DELETE", url: "/api/admin/tables/t1" })
    expect(res.statusCode).toBe(403)
  })

  it("DELETE soft-deactivates via update(active:false)", async () => {
    mockUpdate.mockResolvedValueOnce({ id: "t1", active: false })
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/tables/t1",
      headers: MGR,
    })
    expect(res.statusCode).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith("t1", { active: false })
  })

  it("DELETE maps not-found to 404 pt-BR", async () => {
    mockUpdate.mockRejectedValueOnce(new TableNotFoundError("missing"))
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/tables/missing",
      headers: MGR,
    })
    expect(res.statusCode).toBe(404)
  })

  it("DELETE is BLOCKED with 409 pt-BR when the table has active future reservations", async () => {
    mockUpdate.mockRejectedValueOnce(new TableHasFutureReservationsError("t1", 2))
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/tables/t1",
      headers: MGR,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain("reservas futuras")
  })

  it("PATCH active:false is BLOCKED with 409 when reservations exist", async () => {
    mockUpdate.mockRejectedValueOnce(new TableHasFutureReservationsError("t1", 1))
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/tables/t1",
      headers: MGR,
      payload: { active: false },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain("reservas futuras")
  })

  // ── POST /api/admin/timeslots ──────────────────────────────────────────────

  it("POST timeslots is manager-gated (403 without role)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/timeslots",
      payload: { maxCovers: 40 },
    })
    expect(res.statusCode).toBe(403)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("POST timeslots passes the body through and returns the created count", async () => {
    mockGenerate.mockResolvedValueOnce({ count: 42 })
    const body = {
      fromDate: "2026-08-01",
      toDate: "2026-08-07",
      intervalMinutes: 30,
      maxCovers: 40,
    }
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/timeslots",
      headers: MGR,
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 42 })
    expect(mockGenerate).toHaveBeenCalledWith(body)
  })

  it("POST timeslots maps a RangeError to 400 pt-BR", async () => {
    mockGenerate.mockRejectedValueOnce(new RangeError("fromDate after toDate"))
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/timeslots",
      headers: MGR,
      payload: { fromDate: "2026-08-07", toDate: "2026-08-01", maxCovers: 40 },
    })
    expect(res.statusCode).toBe(400)
  })
})
