// Integration test: Reservation lifecycle via Fastify inject
// Tests: availability → create → list → modify → cancel
//
// All @ibatexas/tools functions are mocked — this tests the HTTP layer,
// Zod validation, and correct status codes throughout the lifecycle.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCheckAvailability = vi.hoisted(() => vi.fn())
const mockCreateReservation = vi.hoisted(() => vi.fn())
const mockGetMyReservations = vi.hoisted(() => vi.fn())
const mockModifyReservation = vi.hoisted(() => vi.fn())
const mockCancelReservation = vi.hoisted(() => vi.fn())
const mockJoinWaitlist = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/tools", () => ({
  checkTableAvailability: mockCheckAvailability,
  createReservation: mockCreateReservation,
  getMyReservations: mockGetMyReservations,
  modifyReservation: mockModifyReservation,
  cancelReservation: mockCancelReservation,
  joinWaitlist: mockJoinWaitlist,
}))

vi.mock("../middleware/auth.js", () => ({
  requireAuth: async (request: any, reply: any) => {
    const customerId = request.headers["x-customer-id"] as string | undefined
    if (!customerId) {
      return reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." })
    }
    request.customerId = customerId
  },
}))

import { reservationRoutes } from "../routes/reservations.js"

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(reservationRoutes)
  await app.ready()
  return app
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CUSTOMER = "cust_123"
const TIMESLOT = "ts_456"
const RESERVATION = "res_789"

describe("Reservation lifecycle integration", () => {
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

  // ── Step 1: Check availability ──────────────────────────────────────────

  it("1. checks availability for a given date", async () => {
    mockCheckAvailability.mockResolvedValue({
      date: "2026-06-15",
      slots: [
        { id: TIMESLOT, time: "19:00", available: true, capacity: 4 },
        { id: "ts_other", time: "20:00", available: true, capacity: 6 },
      ],
    })

    const res = await server.inject({
      method: "GET",
      url: "/api/reservations/availability?date=2026-06-15&partySize=4",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.slots).toHaveLength(2)
    expect(mockCheckAvailability).toHaveBeenCalledWith({
      date: "2026-06-15",
      partySize: 4,
      preferredTime: undefined,
    })
  })

  it("1b. rejects invalid date format", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/reservations/availability?date=15/06/2026&partySize=4",
    })

    expect(res.statusCode).toBe(400)
  })

  it("1c. rejects partySize > 20", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/reservations/availability?date=2026-06-15&partySize=21",
    })

    expect(res.statusCode).toBe(400)
  })

  // ── Step 2: Create reservation ──────────────────────────────────────────

  it("2. creates reservation and returns 201", async () => {
    mockCreateReservation.mockResolvedValue({
      success: true,
      reservation: { id: RESERVATION, status: "confirmed" },
    })

    const res = await server.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "x-customer-id": CUSTOMER },
      payload: {
        timeSlotId: TIMESLOT,
        partySize: 4,
        specialRequests: [],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().reservation.id).toBe(RESERVATION)
    expect(mockCreateReservation).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      timeSlotId: TIMESLOT,
      partySize: 4,
      specialRequests: [],
    })
  })

  it("2b. rejects create without customerId", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/reservations",
      payload: {
        timeSlotId: TIMESLOT,
        partySize: 4,
      },
    })

    expect(res.statusCode).toBe(401)
    expect(mockCreateReservation).not.toHaveBeenCalled()
  })

  // ── Step 3: List reservations ───────────────────────────────────────────

  it("3. lists customer reservations", async () => {
    mockGetMyReservations.mockResolvedValue({
      reservations: [{ id: RESERVATION, status: "confirmed" }],
    })

    const res = await server.inject({
      method: "GET",
      url: "/api/reservations",
      headers: { "x-customer-id": CUSTOMER },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().reservations).toHaveLength(1)
    expect(mockGetMyReservations).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUSTOMER, limit: 10 }),
    )
  })

  // ── Step 4: Modify reservation ──────────────────────────────────────────

  it("4. modifies reservation (new party size)", async () => {
    mockModifyReservation.mockResolvedValue({
      success: true,
      reservation: { id: RESERVATION, partySize: 6, status: "confirmed" },
    })

    const res = await server.inject({
      method: "PATCH",
      url: `/api/reservations/${RESERVATION}`,
      headers: { "x-customer-id": CUSTOMER },
      payload: {
        newPartySize: 6,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
    expect(mockModifyReservation).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      newPartySize: 6,
      reservationId: RESERVATION,
    })
  })

  it("4b. returns 400 when modify fails", async () => {
    mockModifyReservation.mockResolvedValue({
      success: false,
      message: "Reserva não encontrada.",
    })

    const res = await server.inject({
      method: "PATCH",
      url: `/api/reservations/${RESERVATION}`,
      headers: { "x-customer-id": CUSTOMER },
      payload: {
        newPartySize: 6,
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe("Reserva não encontrada.")
  })

  // ── Step 5: Cancel reservation ──────────────────────────────────────────

  it("5. cancels reservation", async () => {
    mockCancelReservation.mockResolvedValue({
      success: true,
      reservation: { id: RESERVATION, status: "cancelled" },
    })

    const res = await server.inject({
      method: "DELETE",
      url: `/api/reservations/${RESERVATION}`,
      headers: { "x-customer-id": CUSTOMER },
      payload: {
        reason: "Mudança de planos",
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
    expect(mockCancelReservation).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      reason: "Mudança de planos",
      reservationId: RESERVATION,
    })
  })

  it("5b. returns 400 when cancel fails", async () => {
    mockCancelReservation.mockResolvedValue({
      success: false,
      message: "Reserva já cancelada.",
    })

    const res = await server.inject({
      method: "DELETE",
      url: `/api/reservations/${RESERVATION}`,
      headers: { "x-customer-id": CUSTOMER },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  // ── Step 6: Join waitlist ───────────────────────────────────────────────

  it("6. joins waitlist for a time slot", async () => {
    mockJoinWaitlist.mockResolvedValue({
      success: true,
      position: 3,
    })

    const res = await server.inject({
      method: "POST",
      url: `/api/reservations/${TIMESLOT}/waitlist`,
      headers: { "x-customer-id": CUSTOMER },
      payload: {
        partySize: 2,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().position).toBe(3)
    expect(mockJoinWaitlist).toHaveBeenCalledWith({
      customerId: CUSTOMER,
      partySize: 2,
      timeSlotId: TIMESLOT,
    })
  })

  it("6b. rejects waitlist join without customerId", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/reservations/${TIMESLOT}/waitlist`,
      payload: {
        partySize: 2,
      },
    })

    expect(res.statusCode).toBe(401)
    expect(mockJoinWaitlist).not.toHaveBeenCalled()
  })
})
