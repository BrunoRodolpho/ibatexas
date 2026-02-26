// Integration tests for reservation routes
// GET  /api/reservations/availability
// POST /api/reservations
// GET  /api/reservations
// PATCH /api/reservations/:id
// DELETE /api/reservations/:id
// POST /api/reservations/:id/waitlist

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockCheckTableAvailability = vi.hoisted(() => vi.fn())
const mockCreateReservation = vi.hoisted(() => vi.fn())
const mockGetMyReservations = vi.hoisted(() => vi.fn())
const mockModifyReservation = vi.hoisted(() => vi.fn())
const mockCancelReservation = vi.hoisted(() => vi.fn())
const mockJoinWaitlist = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/tools", () => ({
  checkTableAvailability: mockCheckTableAvailability,
  createReservation: mockCreateReservation,
  getMyReservations: mockGetMyReservations,
  modifyReservation: mockModifyReservation,
  cancelReservation: mockCancelReservation,
  joinWaitlist: mockJoinWaitlist,
  // Other tools exported from @ibatexas/tools — not used in reservations routes
  searchProducts: vi.fn(),
  getProductDetails: vi.fn(),
}))

// ── Server factory ─────────────────────────────────────────────────────────────

import Fastify from "fastify"
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import { reservationRoutes } from "../routes/reservations.js"

async function buildTestServer() {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(reservationRoutes)
  await app.ready()
  return app
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const AVAILABLE_SLOTS = [
  {
    timeSlotId: "ts_01",
    date: "2026-03-15",
    startTime: "19:30",
    durationMinutes: 90,
    availableCovers: 36,
    tableLocations: ["indoor", "outdoor"],
  },
]

const CREATED_RESERVATION = {
  reservationId: "res_01",
  confirmed: true,
  tableLocation: "indoor",
  dateTime: "2026-03-15T19:30:00.000Z",
  partySize: 4,
  confirmationMessage: "✅ Reserva confirmada!\n📅 15 de março às 19:30\n👥 4 pessoa(s) — Salão Interno",
}

const MY_RESERVATIONS = {
  reservations: [],
  total: 0,
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/reservations/availability", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 200 with available slots", async () => {
    mockCheckTableAvailability.mockResolvedValue({
      slots: AVAILABLE_SLOTS,
      message: "Encontrei 1 horário(s) disponível(is)",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "GET",
      url: "/api/reservations/availability?date=2026-03-15&partySize=4",
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { slots: typeof AVAILABLE_SLOTS }
    expect(body.slots).toHaveLength(1)
    expect(body.slots[0].startTime).toBe("19:30")
    expect(mockCheckTableAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-03-15", partySize: 4 }),
    )
  })

  it("passes optional preferredTime query parameter", async () => {
    mockCheckTableAvailability.mockResolvedValue({ slots: [], message: "" })

    const app = await buildTestServer()
    await app.inject({
      method: "GET",
      url: "/api/reservations/availability?date=2026-03-15&partySize=2&preferredTime=19:30",
    })

    expect(mockCheckTableAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTime: "19:30" }),
    )
  })

  it("returns 400 when date is missing", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "GET",
      url: "/api/reservations/availability?partySize=4",
    })

    expect(res.statusCode).toBe(400)
  })

  it("returns 400 when partySize is missing", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "GET",
      url: "/api/reservations/availability?date=2026-03-15",
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("POST /api/reservations", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 201 with confirmation on success", async () => {
    mockCreateReservation.mockResolvedValue(CREATED_RESERVATION)

    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: {
        customerId: "cus_01",
        timeSlotId: "ts_01",
        partySize: 4,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as typeof CREATED_RESERVATION
    expect(body.reservationId).toBe("res_01")
    expect(body.confirmed).toBe(true)
  })

  it("returns 400 when customerId is missing", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: { timeSlotId: "ts_01", partySize: 4 },
    })

    expect(res.statusCode).toBe(400)
    expect(mockCreateReservation).not.toHaveBeenCalled()
  })

  it("returns 400 when partySize exceeds 20", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: { customerId: "cus_01", timeSlotId: "ts_01", partySize: 25 },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("GET /api/reservations", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 200 with reservations list", async () => {
    mockGetMyReservations.mockResolvedValue(MY_RESERVATIONS)

    const app = await buildTestServer()
    const res = await app.inject({
      method: "GET",
      url: "/api/reservations?customerId=cus_01",
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as typeof MY_RESERVATIONS
    expect(body.reservations).toHaveLength(0)
    expect(body.total).toBe(0)
    expect(mockGetMyReservations).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_01" }),
    )
  })

  it("returns 400 when customerId is missing", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "GET",
      url: "/api/reservations",
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("PATCH /api/reservations/:id", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 200 on successful modification", async () => {
    mockModifyReservation.mockResolvedValue({
      success: true,
      reservation: { id: "res_01" },
      message: "Reserva modificada.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "PATCH",
      url: "/api/reservations/res_01",
      payload: { customerId: "cus_01", newPartySize: 6 },
    })

    expect(res.statusCode).toBe(200)
    expect(mockModifyReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "res_01", customerId: "cus_01" }),
    )
  })

  it("returns 400 when tool returns success:false", async () => {
    mockModifyReservation.mockResolvedValue({
      success: false,
      reservation: null,
      message: "Reserva não encontrada.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "PATCH",
      url: "/api/reservations/res_99",
      payload: { customerId: "cus_01" },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("DELETE /api/reservations/:id", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 200 on successful cancellation", async () => {
    mockCancelReservation.mockResolvedValue({
      success: true,
      message: "Reserva cancelada com sucesso.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "DELETE",
      url: "/api/reservations/res_01",
      payload: { customerId: "cus_01" },
    })

    expect(res.statusCode).toBe(200)
    expect(mockCancelReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "res_01", customerId: "cus_01" }),
    )
  })

  it("returns 400 when tool returns success:false", async () => {
    mockCancelReservation.mockResolvedValue({
      success: false,
      message: "Você não tem permissão para cancelar esta reserva.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "DELETE",
      url: "/api/reservations/res_01",
      payload: { customerId: "cus_WRONG" },
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("POST /api/reservations/:id/waitlist", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 201 with waitlist entry on success", async () => {
    mockJoinWaitlist.mockResolvedValue({
      waitlistId: "wl_01",
      position: 1,
      message: "Você está na posição 1 da lista de espera.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations/ts_01/waitlist",
      payload: { customerId: "cus_01", partySize: 2 },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { waitlistId: string; position: number }
    expect(body.waitlistId).toBe("wl_01")
    expect(body.position).toBe(1)
    expect(mockJoinWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({ timeSlotId: "ts_01", customerId: "cus_01" }),
    )
  })

  it("returns 400 when partySize is missing", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations/ts_01/waitlist",
      payload: { customerId: "cus_01" },
    })

    expect(res.statusCode).toBe(400)
    expect(mockJoinWaitlist).not.toHaveBeenCalled()
  })
})
