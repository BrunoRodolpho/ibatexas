// admin/analytics.ts — GET /api/admin/analytics/summary (thin shell over the
// shared composeSalesAnalytics). Locks: the flat DTO threads every composer
// figure AND (BKL-128) the `degraded` signal list — the dashboard renders a
// degraded signal's tiles as "indisponível" instead of the composer's zero
// fallbacks, so the field must survive the response schema.

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockCompose = vi.hoisted(() => vi.fn());

vi.mock("../../../ops/sales-analytics-compose.js", () => ({
  composeSalesAnalytics: mockCompose,
}));
vi.mock("@ibatexas/domain", () => ({
  prisma: { customer: { count: vi.fn() } },
}));
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(),
}));
vi.mock("../_shared.js", () => ({
  medusaAdmin: vi.fn(),
}));

const VIEW = {
  now: "2026-07-05T21:00:00.000Z",
  orders: { ordersCount: 12, revenueCentavos: 144_000, aovCentavos: 12_000 },
  activeCarts: 3,
  newCustomers30d: 7,
  whatsapp: { conversionRatePct: 40, avgMessagesToCheckout: 6, outreachWeekly: 12 },
  degraded: [] as string[],
};

async function buildServer() {
  const { analyticsRoutes } = await import("../analytics.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(analyticsRoutes);
  await app.ready();
  return app;
}

describe("GET /api/admin/analytics/summary", () => {
  it("threads every composer figure into the flat DTO (clean day: degraded [])", async () => {
    mockCompose.mockResolvedValue(VIEW);
    const server = await buildServer();
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/analytics/summary" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ordersToday: 12,
        revenueToday: 144_000,
        aov: 12_000,
        activeCarts: 3,
        newCustomers30d: 7,
        outreachWeekly: 12,
        waConversionRate: 40,
        avgMessagesToCheckout: 6,
        degraded: [],
      });
    } finally {
      await server.close();
    }
  });

  it("BKL-128: a degraded signal SURVIVES the response schema (the dashboard must not see confident zeros)", async () => {
    mockCompose.mockResolvedValue({
      ...VIEW,
      orders: { ordersCount: 0, revenueCentavos: 0, aovCentavos: 0 },
      degraded: ["orders"],
    });
    const server = await buildServer();
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/analytics/summary" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { degraded: string[]; ordersToday: number };
      // The zeros are the composer's FALLBACK — the degraded marker is what lets
      // the dashboard render "indisponível" instead of lying with them.
      expect(body.degraded).toEqual(["orders"]);
      expect(body.ordersToday).toBe(0);
    } finally {
      await server.close();
    }
  });
});
