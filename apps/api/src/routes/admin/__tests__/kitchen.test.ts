// admin/kitchen.ts — manager-gated read-only kitchen ticket board (NEW-010).
// Locks: requireManagerRole fail-closed (403) for ATTENDANT (no service call);
// 200 with the KitchenBoard shape for MANAGER.
//
// Harness mirrors analytics-reports.test.ts: an instance-level preHandler injects
// the staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockGetTickets = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createKitchenService: () => ({
    getTickets: mockGetTickets,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

const SAMPLE_BOARD = {
  now: "2026-07-04T12:00:00.000Z",
  tickets: [
    {
      orderId: "o_old",
      displayId: 9,
      fulfillmentStatus: "preparing",
      items: [{ productId: "p_a", title: "Picanha", quantity: 2, priceInCentavos: 8900 }],
      itemCount: 2,
      ticketAgeMs: 3_600_000,
      statusSince: "2026-07-04T11:30:00.000Z",
      timeInStatusMs: 1_800_000,
    },
    {
      orderId: "o_new",
      displayId: 12,
      fulfillmentStatus: "pending",
      items: [{ productId: "p_b", title: "Refrigerante", quantity: 1, priceInCentavos: 700 }],
      itemCount: 1,
      ticketAgeMs: 300_000,
      statusSince: "2026-07-04T11:55:00.000Z",
      timeInStatusMs: 300_000,
    },
  ],
  queueDepth: [
    { status: "pending", count: 1 },
    { status: "confirmed", count: 0 },
    { status: "preparing", count: 1 },
    { status: "ready", count: 0 },
  ],
  totalActive: 2,
};

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminKitchenRoutes } = await import("../kitchen.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminKitchenRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/kitchen/tickets is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never queries the service", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/kitchen/tickets" });
      expect(res.statusCode).toBe(403);
      expect(mockGetTickets).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns 200 with the KitchenBoard for MANAGER", async () => {
    mockGetTickets.mockResolvedValue(SAMPLE_BOARD);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/kitchen/tickets" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as typeof SAMPLE_BOARD;
      expect(body.now).toBe("2026-07-04T12:00:00.000Z");
      expect(body.totalActive).toBe(2);
      // Oldest-first: the older ticket is first.
      expect(body.tickets.map((t) => t.orderId)).toEqual(["o_old", "o_new"]);
      expect(body.tickets[0]).toMatchObject({
        displayId: 9,
        fulfillmentStatus: "preparing",
        itemCount: 2,
        ticketAgeMs: 3_600_000,
        timeInStatusMs: 1_800_000,
      });
      expect(body.queueDepth).toEqual(SAMPLE_BOARD.queueDepth);
      expect(mockGetTickets).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
