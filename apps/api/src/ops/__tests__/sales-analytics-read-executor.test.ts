// sales-analytics-read-executor — the ops_sales_analytics read executor closure
// (NEW-012). Mocks the real reads it binds (@ibatexas/tools medusaAdmin +
// getRedisClient, @ibatexas/domain prisma) so the closure body (bind → compose)
// runs without a DB / HTTP / Redis. Proves the shape + the per-signal fallback.

import { describe, expect, it, vi } from "vitest";
import { createSalesAnalyticsReadExecutor } from "../ops-read-executor.js";

// vitest hoists vi.hoisted + vi.mock above the SUT import above, so the executor
// module loads against these mocks.
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  // The snapshot executor's services (this module also builds ops_snapshot);
  // present so the named imports resolve — unused by the sales executor.
  createOpsAlertService: () => ({ list: async () => ({ alerts: [], openCount: 0 }) }),
  createIncidentService: () => ({ list: async () => ({ openCount: 0 }) }),
  createKitchenService: () => ({
    getTickets: async () => ({ totalActive: 0, tickets: [], queueDepth: [] }),
  }),
  createDayCloseService: () => ({
    getDaySummary: async (date: string) => ({
      date,
      orders: { count: 0, grossCentavos: 0 },
      settled: { totalCentavos: 0 },
      refunds: { totalCentavos: 0 },
      netCentavos: 0,
    }),
  }),
  prisma: { customer: { count: vi.fn(async () => 9) } },
}));
vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => ({}) }));
vi.mock("@ibatexas/tools", () => ({
  medusaAdmin: mockMedusaAdmin,
  getRedisClient: vi.fn(async () => ({ get: vi.fn(async () => null) })),
  rk: (key: string) => `t:${key}`,
}));

describe("createSalesAnalyticsReadExecutor", () => {
  it("composes today's sales from the real reads (orders → carts → customers → funnel)", async () => {
    mockMedusaAdmin.mockImplementation(async (path: string) =>
      path.includes("status[]=pending")
        ? { count: 2 }
        : { orders: [{ id: "o1", total: 5000, status: "completed" }] },
    );
    const executor = createSalesAnalyticsReadExecutor();
    const view = await executor({}, {} as never);
    expect(view.orders).toEqual({
      ordersCount: 1,
      revenueCentavos: 5000,
      aovCentavos: 5000,
    });
    expect(view.activeCarts).toBe(2);
    expect(view.newCustomers30d).toBe(9);
    expect(view.whatsapp).toEqual({
      outreachWeekly: 0,
      conversionRatePct: 0,
      avgMessagesToCheckout: 0,
    });
    expect(typeof view.now).toBe("string");
  });

  it("degrades to zeros when the Medusa reads fail (fallback, never throws)", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("medusa down"));
    const executor = createSalesAnalyticsReadExecutor();
    const view = await executor({}, {} as never);
    // Medusa-backed signals fall to zero…
    expect(view.orders).toEqual({
      ordersCount: 0,
      revenueCentavos: 0,
      aovCentavos: 0,
    });
    expect(view.activeCarts).toBe(0);
    // …the Prisma-backed signal still returns.
    expect(view.newCustomers30d).toBe(9);
  });
});
