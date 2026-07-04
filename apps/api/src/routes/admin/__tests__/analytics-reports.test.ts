// admin/analytics-reports.ts — manager-gated read-only order analytics (NEW-013).
// Locks: requireManagerRole fail-closed (403) for ATTENDANT (no service call);
// 200 with the payload for MANAGER; the from/to/limit query params threaded to
// the service; omitted from/to default to a trailing range in RESTAURANT_TIMEZONE;
// a malformed date is rejected (400) by the zod querystring.
//
// Harness mirrors caixa.test.ts: an instance-level preHandler injects the staff
// identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockGetTopItems = vi.hoisted(() => vi.fn());
const mockGetRefundAnalytics = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOrderAnalyticsService: () => ({
    getTopItems: mockGetTopItems,
    getRefundAnalytics: mockGetRefundAnalytics,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

const SAMPLE_TOP_ITEMS = [
  { productId: "prod_picanha", title: "Picanha", quantity: 40, orderCount: 25, grossCentavos: 356000 },
  { productId: "prod_refri", title: "Refrigerante", quantity: 30, orderCount: 20, grossCentavos: 21000 },
];

const SAMPLE_REFUNDS = {
  range: { from: "2026-07-01", to: "2026-07-08" },
  timezone: "America/Sao_Paulo",
  windowStart: "2026-07-01T03:00:00.000Z",
  windowEnd: "2026-07-08T03:00:00.000Z",
  totalRefundedCentavos: 8500,
  refundCount: 3,
  trend: [
    { date: "2026-07-01", refundedCentavos: 3500, count: 2 },
    { date: "2026-07-03", refundedCentavos: 5000, count: 1 },
  ],
};

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminAnalyticsReportRoutes } = await import("../analytics-reports.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminAnalyticsReportRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/analytics/top-items is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never queries the service", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/analytics/top-items?from=2026-07-01&to=2026-07-08",
      });
      expect(res.statusCode).toBe(403);
      expect(mockGetTopItems).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns 200 with the best-sellers for MANAGER and threads from/to/limit", async () => {
    mockGetTopItems.mockResolvedValue(SAMPLE_TOP_ITEMS);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/analytics/top-items?from=2026-07-01&to=2026-07-08&limit=5",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { range: { from: string; to: string }; items: typeof SAMPLE_TOP_ITEMS };
      expect(body.range).toEqual({ from: "2026-07-01", to: "2026-07-08" });
      expect(body.items).toEqual(SAMPLE_TOP_ITEMS);
      // Range + limit threaded through to the service.
      expect(mockGetTopItems).toHaveBeenCalledWith(
        { from: "2026-07-01", to: "2026-07-08" },
        { limit: 5 },
      );
    } finally {
      await server.close();
    }
  });

  it("defaults the range (RESTAURANT_TIMEZONE) when from/to are omitted", async () => {
    mockGetTopItems.mockResolvedValue([]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/analytics/top-items" });
      expect(res.statusCode).toBe(200);
      const range = mockGetTopItems.mock.calls[0]?.[0] as { from: string; to: string };
      expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // `to` is exclusive and defaults to tomorrow → strictly after `from`.
      expect(range.to > range.from).toBe(true);
      // Default limit is left to the service (opts.limit undefined).
      expect(mockGetTopItems.mock.calls[0]?.[1]).toEqual({ limit: undefined });
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed date with 400 and never queries the service", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/analytics/top-items?from=01-07-2026",
      });
      expect(res.statusCode).toBe(400);
      expect(mockGetTopItems).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/analytics/refunds is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never queries the service", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/analytics/refunds?from=2026-07-01&to=2026-07-08",
      });
      expect(res.statusCode).toBe(403);
      expect(mockGetRefundAnalytics).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns 200 with the RefundAnalytics for MANAGER and threads the range", async () => {
    mockGetRefundAnalytics.mockResolvedValue(SAMPLE_REFUNDS);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/analytics/refunds?from=2026-07-01&to=2026-07-08",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as typeof SAMPLE_REFUNDS;
      expect(body).toMatchObject({
        totalRefundedCentavos: 8500,
        refundCount: 3,
        trend: [
          { date: "2026-07-01", refundedCentavos: 3500, count: 2 },
          { date: "2026-07-03", refundedCentavos: 5000, count: 1 },
        ],
      });
      expect(mockGetRefundAnalytics).toHaveBeenCalledWith({ from: "2026-07-01", to: "2026-07-08" });
    } finally {
      await server.close();
    }
  });

  it("defaults the range (RESTAURANT_TIMEZONE) when from/to are omitted", async () => {
    mockGetRefundAnalytics.mockResolvedValue(SAMPLE_REFUNDS);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/analytics/refunds" });
      expect(res.statusCode).toBe(200);
      const range = mockGetRefundAnalytics.mock.calls[0]?.[0] as { from: string; to: string };
      expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.to > range.from).toBe(true);
    } finally {
      await server.close();
    }
  });
});
