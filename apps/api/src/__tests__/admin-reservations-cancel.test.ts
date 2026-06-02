// Route-level parity tests for admin POST /api/admin/reservations/:id/cancel
// (D-C: land BEFORE the cutover; D-B owner-customerId path).
//
// Legacy behavior under test:
//   - reservation not found      → 404
//   - terminal status            → 422 (cancelled/completed/no_show)
//   - happy path                 → 200, $transaction([update cancelled,
//                                  deleteMany tables, timeSlot decrement]) runs
//
// claustrum-bootstrap is NOT mocked → tryGetConductor() === null → inert legacy
// path, the byte-equivalent target.

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

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockResvUpdate = vi.hoisted(() => vi.fn(() => ({ __op: "resv.update" })));
const mockResvTableDeleteMany = vi.hoisted(() => vi.fn(() => ({ __op: "table.deleteMany" })));
const mockTimeSlotUpdate = vi.hoisted(() => vi.fn(() => ({ __op: "slot.update" })));
const mockTransaction = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createReservationService: () => ({ listAll: vi.fn(), transition: vi.fn() }),
  prisma: {
    reservation: { findUnique: mockFindUnique, update: mockResvUpdate },
    reservationTable: { deleteMany: mockResvTableDeleteMany, findMany: vi.fn() },
    timeSlot: { update: mockTimeSlotUpdate },
    customer: { findMany: vi.fn() },
    $transaction: mockTransaction,
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

function cancel(app: Awaited<ReturnType<typeof buildServer>>) {
  return app.inject({ method: "POST", url: "/api/admin/reservations/res_1/cancel", payload: {} });
}

describe("admin reservation cancel — legacy parity (inert)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockResolvedValue([{}, {}, {}]);
  });

  it("reservation not found → 404", async () => {
    mockFindUnique.mockResolvedValue(null);
    const app = await buildServer();
    const res = await cancel(app);
    expect(res.statusCode).toBe(404);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("terminal status (cancelled) → 422, no transaction", async () => {
    mockFindUnique.mockResolvedValue({
      id: "res_1", status: "cancelled", partySize: 4, timeSlotId: "ts_1", customerId: "c1",
    });
    const app = await buildServer();
    const res = await cancel(app);
    expect(res.statusCode).toBe(422);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("happy path: runs the 3-op cancel transaction, returns 200", async () => {
    mockFindUnique.mockResolvedValue({
      id: "res_1", status: "confirmed", partySize: 4, timeSlotId: "ts_1", customerId: "c1",
    });
    const app = await buildServer();
    const res = await cancel(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // The cancel mutation: reservation→cancelled, tables released, slot covers decremented.
    expect(mockResvUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "res_1" }, data: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(mockResvTableDeleteMany).toHaveBeenCalledWith({ where: { reservationId: "res_1" } });
    expect(mockTimeSlotUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ts_1" }, data: { reservedCovers: { decrement: 4 } } }),
    );
  });
});
