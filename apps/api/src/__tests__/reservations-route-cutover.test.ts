// RC-A1 Phase B — pin test for the reservations route cutover (Chunk 3).
//
// Proves the four customer reservation handlers behave BYTE-EQUIVALENTLY to
// their pre-wrap form while the conductor is INERT (`tryGetConductor()` → null).
// In that state `adjudicateCustomerMutation` runs `opts.legacy()` directly and
// returns `{ ran: true, result }`, so:
//   - the same domain tool is invoked with the SAME args as before the wrap, and
//   - the SAME HTTP status + body is returned (incl. the modify/cancel 400
//     `{ statusCode, message }` on `result.success === false`).
//
// Boundaries mocked exactly like the existing reservations route test
// (`reservations.test.ts`): `@ibatexas/tools` + `../middleware/auth.js`. The
// bootstrap module is additionally mocked so the inert branch is asserted
// explicitly (tryGetConductor → null) and the real Conductor composition
// (packs + audit Postgres) is never loaded into the unit test.

import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyRequest, FastifyReply } from "fastify"
import { reservationRoutes } from "../routes/reservations.js"

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

vi.mock("../middleware/auth.js", () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    const customerId = request.headers["x-customer-id"] as string | undefined
    if (!customerId) {
      return reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." })
    }
    request.customerId = customerId
  },
}))

// INERT conductor: tryGetConductor() → null forces the legacy direct path, the
// only branch exercised pre-activation. getConductor / policyForKind are stubbed
// so the module imports cleanly without the real (Postgres-backed) bootstrap.
vi.mock("../claustrum-bootstrap.js", () => ({
  tryGetConductor: () => null,
  getConductor: () => {
    throw new Error("getConductor must not be called on the inert legacy path")
  },
  policyForKind: () => null,
}))

async function buildTestServer() {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(reservationRoutes)
  await app.ready()
  return app
}

// ── Fixtures (mirror reservations.test.ts) ───────────────────────────────────────

const CREATED_RESERVATION = {
  reservationId: "res_01",
  confirmed: true,
  tableLocation: "indoor",
  dateTime: "2026-03-15T19:30:00.000Z",
  partySize: 4,
  confirmationMessage: "✅ Reserva confirmada!",
}

// ── POST /api/reservations — create ──────────────────────────────────────────────

describe("POST /api/reservations — inert cutover (byte-equivalent)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("calls createReservation with {...body, customerId} and returns 201 + result", async () => {
    mockCreateReservation.mockResolvedValue(CREATED_RESERVATION)

    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "x-customer-id": "cus_01" },
      payload: {
        timeSlotId: "ts_01",
        partySize: 4,
        specialRequests: [{ type: "window_seat", notes: "perto da janela" }],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toEqual(CREATED_RESERVATION)
    // Same legacy args as the pre-wrap handler: {...body, customerId}. The
    // Zod-defaulted specialRequests array is forwarded verbatim.
    expect(mockCreateReservation).toHaveBeenCalledTimes(1)
    expect(mockCreateReservation).toHaveBeenCalledWith({
      timeSlotId: "ts_01",
      partySize: 4,
      specialRequests: [{ type: "window_seat", notes: "perto da janela" }],
      customerId: "cus_01",
    })
  })

  it("returns 401 and does NOT call createReservation when unauthenticated", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: { timeSlotId: "ts_01", partySize: 4 },
    })

    expect(res.statusCode).toBe(401)
    expect(mockCreateReservation).not.toHaveBeenCalled()
  })

  it("returns 400 (Zod) before the wrapper when partySize exceeds 20", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "x-customer-id": "cus_01" },
      payload: { timeSlotId: "ts_01", partySize: 25 },
    })

    expect(res.statusCode).toBe(400)
    expect(mockCreateReservation).not.toHaveBeenCalled()
  })
})

// ── PATCH /api/reservations/:id — modify ─────────────────────────────────────────

describe("PATCH /api/reservations/:id — inert cutover (byte-equivalent)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("calls modifyReservation with {...body, customerId, reservationId} and returns 200 + result on success", async () => {
    const ok = { success: true, reservation: { id: "res_01" }, message: "Reserva modificada." }
    mockModifyReservation.mockResolvedValue(ok)

    const app = await buildTestServer()
    const res = await app.inject({
      method: "PATCH",
      url: "/api/reservations/res_01",
      headers: { "x-customer-id": "cus_01" },
      payload: { newPartySize: 6 },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(ok)
    expect(mockModifyReservation).toHaveBeenCalledTimes(1)
    expect(mockModifyReservation).toHaveBeenCalledWith({
      newPartySize: 6,
      customerId: "cus_01",
      reservationId: "res_01",
    })
  })

  it("preserves the 400 {statusCode, message} response on success:false (EXECUTE/ran path)", async () => {
    mockModifyReservation.mockResolvedValue({
      success: false,
      reservation: null,
      message: "Reserva não encontrada.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "PATCH",
      url: "/api/reservations/res_99",
      headers: { "x-customer-id": "cus_01" },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ statusCode: 400, message: "Reserva não encontrada." })
  })
})

// ── DELETE /api/reservations/:id — cancel ────────────────────────────────────────

describe("DELETE /api/reservations/:id — inert cutover (byte-equivalent)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("calls cancelReservation with {...body, customerId, reservationId} and returns 200 + result on success", async () => {
    const ok = { success: true, message: "Reserva cancelada com sucesso." }
    mockCancelReservation.mockResolvedValue(ok)

    const app = await buildTestServer()
    const res = await app.inject({
      method: "DELETE",
      url: "/api/reservations/res_01",
      headers: { "x-customer-id": "cus_01" },
      payload: { reason: "mudança de planos" },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(ok)
    expect(mockCancelReservation).toHaveBeenCalledTimes(1)
    expect(mockCancelReservation).toHaveBeenCalledWith({
      reason: "mudança de planos",
      customerId: "cus_01",
      reservationId: "res_01",
    })
  })

  it("preserves the 400 {statusCode, message} response on success:false (EXECUTE/ran path)", async () => {
    mockCancelReservation.mockResolvedValue({
      success: false,
      message: "Você não tem permissão para cancelar esta reserva.",
    })

    const app = await buildTestServer()
    const res = await app.inject({
      method: "DELETE",
      url: "/api/reservations/res_01",
      headers: { "x-customer-id": "cus_WRONG" },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      statusCode: 400,
      message: "Você não tem permissão para cancelar esta reserva.",
    })
  })
})

// ── POST /api/reservations/:id/waitlist — join ───────────────────────────────────

describe("POST /api/reservations/:id/waitlist — inert cutover (byte-equivalent)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("calls joinWaitlist with {...body, customerId, timeSlotId} and returns 201 + result", async () => {
    const ok = { waitlistId: "wl_01", position: 1, message: "Você está na posição 1 da lista de espera." }
    mockJoinWaitlist.mockResolvedValue(ok)

    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations/ts_01/waitlist",
      headers: { "x-customer-id": "cus_01" },
      payload: { partySize: 2 },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toEqual(ok)
    expect(mockJoinWaitlist).toHaveBeenCalledTimes(1)
    // timeSlotId comes from the URL param (:id), not the body.
    expect(mockJoinWaitlist).toHaveBeenCalledWith({
      partySize: 2,
      customerId: "cus_01",
      timeSlotId: "ts_01",
    })
  })

  it("returns 400 (Zod) before the wrapper when partySize is missing", async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: "POST",
      url: "/api/reservations/ts_01/waitlist",
      headers: { "x-customer-id": "cus_01" },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(mockJoinWaitlist).not.toHaveBeenCalled()
  })
})
