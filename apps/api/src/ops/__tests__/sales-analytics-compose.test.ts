// sales-analytics-compose — the shared sales-analytics composition (NEW-012).
//
// Verifies the fold of the four signals (orders/revenue/AOV, active carts, new
// customers, WA funnel), the exact reads it reuses (Medusa orders HTTP keyed on
// the today boundary, the rk-prefixed Redis funnel keys), and the per-signal
// resilience (one bad read degrades to its zero fallback; the others survive).

import { describe, expect, it, vi } from "vitest";
import {
  composeSalesAnalytics,
  type SalesAnalyticsComposeDeps,
} from "../sales-analytics-compose.js";

// `rk` is the only @ibatexas/tools symbol the composer touches — mock it to a
// pure prefixer so the test is hermetic (no Redis client construction) and the
// injected `redisGet` can be keyed on the prefixed names the composer builds.
// (vitest hoists this vi.mock above the import above.)
vi.mock("@ibatexas/tools", () => ({ rk: (key: string) => `ibx:${key}` }));

const LOG = { error: vi.fn() };
const NOW = new Date("2026-07-04T12:00:00.000Z");

/** The rk-prefixed Redis funnel values for a healthy day (2026-07-04). */
const REDIS: Record<string, string> = {
  "ibx:outreach:weekly:count": "12",
  "ibx:metrics:conversations:daily:2026-07-04": "10",
  "ibx:metrics:wa_orders:daily:2026-07-04": "4",
  "ibx:metrics:avg_messages_to_checkout": "5.6",
};

function makeDeps(
  over: Partial<SalesAnalyticsComposeDeps> = {},
): SalesAnalyticsComposeDeps {
  return {
    // Dispatch by path: the pending-carts read → { count }, else the orders read.
    medusaAdmin: async (path: string) =>
      path.includes("status[]=pending")
        ? { count: 3 }
        : {
            orders: [
              { id: "order_01", total: 8900, status: "completed" },
              { id: "order_02", total: 5500, status: "completed" },
            ],
          },
    countNewCustomers: async () => 7,
    redisGet: async (key: string) => REDIS[key] ?? null,
    now: NOW,
    log: LOG,
    ...over,
  };
}

describe("composeSalesAnalytics", () => {
  it("folds the four signals into the compact sales view", async () => {
    const view = await composeSalesAnalytics(makeDeps());
    expect(view.orders).toEqual({
      ordersCount: 2,
      revenueCentavos: 14_400,
      aovCentavos: 7_200,
    });
    expect(view.activeCarts).toBe(3);
    expect(view.newCustomers30d).toBe(7);
    expect(view.whatsapp).toEqual({
      outreachWeekly: 12,
      conversionRatePct: 40, // round(4 / 10 * 100)
      avgMessagesToCheckout: 6, // round(5.6)
    });
    expect(typeof view.now).toBe("string");
    // BKL-100 — no signal failed, so nothing is flagged degraded.
    expect(view.degraded).toEqual([]);
  });

  it("reuses the exact reads: today-boundary orders window + rk-prefixed funnel keys", async () => {
    const paths: string[] = [];
    const keys: string[] = [];
    await composeSalesAnalytics(
      makeDeps({
        medusaAdmin: async (path: string) => {
          paths.push(path);
          return path.includes("status[]=pending")
            ? { count: 3 }
            : { orders: [] };
        },
        redisGet: async (key: string) => {
          keys.push(key);
          return REDIS[key] ?? null;
        },
      }),
    );
    // Orders window opens at the LOCAL midnight boundary derived from `now`.
    const todayStart = new Date(NOW);
    todayStart.setHours(0, 0, 0, 0);
    expect(paths.some((p) => p.includes("/admin/orders?"))).toBe(true);
    expect(
      paths.some((p) =>
        p.includes(encodeURIComponent(todayStart.toISOString())),
      ),
    ).toBe(true);
    expect(paths.some((p) => p.includes("status%5B%5D=pending") || p.includes("status[]=pending"))).toBe(true);
    // Redis keys are rk-prefixed and the daily counters carry today's date.
    expect(keys).toContain("ibx:outreach:weekly:count");
    expect(keys).toContain("ibx:metrics:conversations:daily:2026-07-04");
    expect(keys).toContain("ibx:metrics:wa_orders:daily:2026-07-04");
    expect(keys).toContain("ibx:metrics:avg_messages_to_checkout");
  });

  it("degrades ONE failing signal (new customers) to zero; the others survive", async () => {
    const view = await composeSalesAnalytics(
      makeDeps({
        countNewCustomers: async () => {
          throw new Error("prisma hiccup");
        },
      }),
    );
    expect(view.newCustomers30d).toBe(0); // degraded
    expect(view.orders.ordersCount).toBe(2); // intact
    expect(view.activeCarts).toBe(3);
    expect(view.whatsapp.outreachWeekly).toBe(12);
    // BKL-100 — the failed signal is flagged so a renderer never shows its zero.
    expect(view.degraded).toEqual(["newCustomers30d"]);
  });

  it("degrades the orders signal alone; carts + funnel survive", async () => {
    const view = await composeSalesAnalytics(
      makeDeps({
        medusaAdmin: async (path: string) => {
          if (path.includes("status[]=pending")) return { count: 3 };
          throw new Error("medusa orders down");
        },
      }),
    );
    expect(view.orders).toEqual({
      ordersCount: 0,
      revenueCentavos: 0,
      aovCentavos: 0,
    });
    expect(view.activeCarts).toBe(3);
    expect(view.whatsapp.conversionRatePct).toBe(40);
    // BKL-100 — only the orders signal degraded.
    expect(view.degraded).toEqual(["orders"]);
  });

  it("AOV is 0 with no orders; conversion is 0 with no conversations; absent funnel keys → 0", async () => {
    const view = await composeSalesAnalytics(
      makeDeps({
        medusaAdmin: async (path: string) =>
          path.includes("status[]=pending") ? { count: 0 } : { orders: [] },
        redisGet: async () => null, // every funnel key absent
      }),
    );
    expect(view.orders.aovCentavos).toBe(0);
    expect(view.activeCarts).toBe(0);
    expect(view.whatsapp).toEqual({
      outreachWeekly: 0,
      conversionRatePct: 0,
      avgMessagesToCheckout: 0,
    });
  });
});
