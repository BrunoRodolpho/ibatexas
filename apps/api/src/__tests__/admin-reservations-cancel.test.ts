// Admin reservation cancel — kernel-routed envelope path (P0-4).
//
// The route previously did a direct `prisma.$transaction([...])` write
// that bypassed `reservationCmdSvc.cancelFromEnvelope`. The audit
// flagged this as a P0 bypass (Bypass Hunter §4). This test pins the
// new path: the route MUST call `cancelFromEnvelope` with a TRUSTED
// (or SYSTEM) admin envelope carrying `kind: "reservation.cancel"`,
// `actor.principal: "user"|"system"`, `sessionId: "admin:{staffId}"`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockCancelFromEnvelope = vi.hoisted(() => vi.fn())
const mockListAll = vi.hoisted(() => vi.fn())
const mockReservationFindUnique = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createReservationService: () => ({
    listAll: mockListAll,
    cancelFromEnvelope: mockCancelFromEnvelope,
    transitionFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: undefined,
    })),
  }),
  prisma: {
    reservation: { findUnique: mockReservationFindUnique },
    customer: { findMany: vi.fn(async () => []) },
    reservationTable: { findMany: vi.fn(async () => []) },
  },
}))

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}))

// Bypass auth — set staffId on the request so requireManagerRole resolves.
// `vi.mock` paths are resolved against the SUT file's relative imports;
// `routes/admin/reservations.ts` imports `../../middleware/staff-auth.js`,
// so we register the mock under that exact specifier.
vi.mock("../middleware/staff-auth.js", () => ({
  requireManagerRole: async (req: import("fastify").FastifyRequest) => {
    const staffId = req.headers["x-staff-id"] as string | undefined
    if (staffId) {
      ;(req as unknown as { staffId: string }).staffId = staffId
    }
  },
}))

// ── Server factory ─────────────────────────────────────────────────────────

async function buildTestServer(): Promise<FastifyInstance> {
  const { reservationRoutes } = await import("../routes/admin/reservations.js")
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(reservationRoutes)
  await app.ready()
  return app
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/admin/reservations/:id/cancel — P0-4 kernel envelope path", () => {
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

  it("404s when the reservation is missing", async () => {
    mockReservationFindUnique.mockResolvedValue(null)

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/reservations/res_missing/cancel",
      headers: { "x-staff-id": "staff_01" },
    })

    expect(res.statusCode).toBe(404)
    expect(mockCancelFromEnvelope).not.toHaveBeenCalled()
  })

  it("EXECUTEs cancel via cancelFromEnvelope (TRUSTED admin envelope)", async () => {
    mockReservationFindUnique.mockResolvedValue({
      id: "res_01",
      customerId: "cust_42",
      status: "confirmed",
      partySize: 4,
      timeSlotId: "ts_99",
      timeSlot: { id: "ts_99" },
    })
    mockCancelFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { timeSlotId: "ts_99", partySize: 4 },
    })

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/reservations/res_01/cancel",
      headers: { "x-staff-id": "staff_01" },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    expect(mockCancelFromEnvelope).toHaveBeenCalledTimes(1)

    const [envelope, state, extras] = mockCancelFromEnvelope.mock.calls[0]
    // Envelope shape — kind, taint, actor.
    expect(envelope.kind).toBe("reservation.cancel")
    expect(envelope.taint).toBe("TRUSTED")
    expect(envelope.actor.principal).toBe("user")
    expect(envelope.actor.sessionId).toBe("admin:staff_01")
    expect(envelope.payload).toEqual({ reservationId: "res_01" })
    // State projection — auth guard requires customerId !== null;
    // the inner ownership check passes when extras.customerId matches.
    expect(state.ctx.customerId).toBe("cust_42")
    expect(state.ctx.staffId).toBe("staff_01")
    expect(state.ctx.reservation).toMatchObject({
      id: "res_01",
      status: "confirmed",
      partySize: 4,
      timeSlotId: "ts_99",
    })
    expect(extras).toEqual({ customerId: "cust_42" })
  })

  it("422 with pt-BR refusal when the pack REFUSEs the cancel", async () => {
    mockReservationFindUnique.mockResolvedValue({
      id: "res_02",
      customerId: "cust_42",
      status: "confirmed",
      partySize: 2,
      timeSlotId: "ts_99",
      timeSlot: { id: "ts_99" },
    })
    mockCancelFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: {
          kind: "STATE",
          code: "reservation.not_cancellable",
          userFacing: "Reserva não pode ser cancelada neste status.",
        },
        basis: [],
      },
      result: null,
    })

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/reservations/res_02/cancel",
      headers: { "x-staff-id": "staff_01" },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().error).toContain("não pode ser cancelada")
  })

  it("uses SYSTEM taint and admin:api-key sessionId when no staff JWT is present", async () => {
    mockReservationFindUnique.mockResolvedValue({
      id: "res_03",
      customerId: "cust_42",
      status: "confirmed",
      partySize: 2,
      timeSlotId: "ts_99",
      timeSlot: { id: "ts_99" },
    })
    mockCancelFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { timeSlotId: "ts_99", partySize: 2 },
    })

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/reservations/res_03/cancel",
      // intentionally NO x-staff-id header
    })

    expect(res.statusCode).toBe(200)
    expect(mockCancelFromEnvelope).toHaveBeenCalledTimes(1)
    const [envelope] = mockCancelFromEnvelope.mock.calls[0]
    expect(envelope.taint).toBe("SYSTEM")
    expect(envelope.actor.principal).toBe("system")
    expect(envelope.actor.sessionId).toBe("admin:api-key")
  })
})
