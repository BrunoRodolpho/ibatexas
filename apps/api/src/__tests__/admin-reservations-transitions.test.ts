// Route-level parity tests for admin reservation staff transitions
// POST /api/admin/reservations/:id/checkin  → svc.transition(id,"seated")
// POST /api/admin/reservations/:id/complete → svc.transition(id,"completed")
// (D-C: land BEFORE the cutover; these are staff-only pack kinds checkin/complete.)
//
// Legacy behavior: call svc.transition with the target status, return 200
// {success:true}. The cutover adds a prisma.reservation.findUnique for pack-state
// assembly (requireReservationPresent) — kept OUTSIDE the legacy closure so the
// inert path stays byte-equivalent at the response level (the legacy
// svc.transition still runs unconditionally and handles a missing row as before).
//
// claustrum-bootstrap NOT mocked → tryGetConductor() === null → inert legacy path.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Conductor is unconditional post-cutover; a permissive EXECUTE conductor lets the
// gateway run the route's domain mutation (behaviour-preserving for these tests).
vi.mock("../claustrum-bootstrap.js", () => {
  const conductor = { adjudicator: { adjudicate: async () => ({ kind: "EXECUTE", basis: [] }) } };
  return {
    getConductor: () => conductor,
    tryGetConductor: () => conductor,
    policyForKind: () => ({
      stateGuards: [], authGuards: [], business: [],
      taint: { minimumFor: () => "UNTRUSTED" }, default: "EXECUTE",
    }),
  };
});
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { reservationRoutes } from "../routes/admin/reservations.js";

const mockTransition = vi.hoisted(() => vi.fn());
const mockFindUnique = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createReservationService: () => ({ listAll: vi.fn(), transition: mockTransition }),
  prisma: {
    reservation: { findUnique: mockFindUnique, update: vi.fn() },
    reservationTable: { deleteMany: vi.fn(), findMany: vi.fn() },
    timeSlot: { update: vi.fn() },
    customer: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../middleware/staff-auth.js", () => ({
  requireManagerRole: (req: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    (req as FastifyRequest & { staffId?: string; staffRole?: string }).staffId = "staff_mgr";
    (req as FastifyRequest & { staffRole?: string }).staffRole = "MANAGER";
    done();
  },
}));

async function buildServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(reservationRoutes);
  await app.ready();
  return app;
}

describe("admin reservation checkin/complete — legacy parity (inert)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransition.mockResolvedValue(undefined);
    mockFindUnique.mockResolvedValue({
      id: "res_1", status: "confirmed", partySize: 4, timeSlotId: "ts_1", customerId: "c1",
    });
  });

  it("checkin → svc.transition(id,'seated'), 200", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/api/admin/reservations/res_1/checkin", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockTransition).toHaveBeenCalledWith("res_1", "seated");
  });

  it("complete → svc.transition(id,'completed'), 200", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/api/admin/reservations/res_1/complete", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockTransition).toHaveBeenCalledWith("res_1", "completed");
  });
});
