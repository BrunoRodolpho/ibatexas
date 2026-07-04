// admin/caixa.ts — the manager-gated caixa / day-close reconciliation (NEW-011).
// Locks: requireManagerRole fail-closed (403) for ATTENDANT (no service call);
// 200 with the DaySummary for MANAGER; the `date` query param threaded to the
// service; an omitted `date` defaults to today in RESTAURANT_TIMEZONE; a malformed date
// is rejected (400) by the zod querystring.
//
// Harness mirrors ops-alerts.test.ts: an instance-level preHandler injects the
// staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockGetDaySummary = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createDayCloseService: () => ({
    getDaySummary: mockGetDaySummary,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

const SAMPLE_SUMMARY = {
  date: "2026-07-03",
  timezone: "America/Sao_Paulo",
  windowStart: "2026-07-03T03:00:00.000Z",
  windowEnd: "2026-07-04T03:00:00.000Z",
  orders: { count: 3, grossCentavos: 25900 },
  settled: { count: 5, totalCentavos: 31900, byMethod: { pix: 12900, card: 7000, cash: 12000 } },
  refunds: { count: 2, totalCentavos: 3500, byMethod: { pix: 1500, card: 2000, cash: 0 } },
  netCentavos: 28400,
};

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminCaixaRoutes } = await import("../caixa.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminCaixaRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/caixa/day-close is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never queries the service", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/caixa/day-close?date=2026-07-03",
      });
      expect(res.statusCode).toBe(403);
      expect(mockGetDaySummary).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns 200 with the DaySummary for MANAGER and threads the date param", async () => {
    mockGetDaySummary.mockResolvedValue(SAMPLE_SUMMARY);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/caixa/day-close?date=2026-07-03",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as typeof SAMPLE_SUMMARY;
      expect(body).toMatchObject({
        orders: { count: 3, grossCentavos: 25900 },
        settled: { totalCentavos: 31900, byMethod: { pix: 12900, card: 7000, cash: 12000 } },
        refunds: { count: 2, totalCentavos: 3500 },
        netCentavos: 28400,
      });
      // The date query param is threaded through to the service.
      expect(mockGetDaySummary).toHaveBeenCalledWith("2026-07-03");
    } finally {
      await server.close();
    }
  });

  it("defaults to today in RESTAURANT_TIMEZONE (not server-local) when date is omitted", async () => {
    mockGetDaySummary.mockResolvedValue(SAMPLE_SUMMARY);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/caixa/day-close" });
      expect(res.statusCode).toBe(200);
      const arg = mockGetDaySummary.mock.calls[0]?.[0] as string;
      expect(arg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The route defaults to today in the restaurant's business timezone (the same
      // zone the service resolves the window in) — CI-tz-independent, so this must
      // compute the expected value the SAME way, never as server-local.
      const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
      expect(arg).toBe(new Date().toLocaleDateString("en-CA", { timeZone: tz }));
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed date with 400 and never queries the service", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/caixa/day-close?date=03-07-2026",
      });
      expect(res.statusCode).toBe(400);
      expect(mockGetDaySummary).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
