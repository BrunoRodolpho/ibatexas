// specials.ts — the PUBLIC daily-specials read (NEW-038 slice (a)). Locks: no auth
// (mounts with no staff preHandler); GET /api/specials/today reads
// getForDate(todayInRestaurantTz()); the response projects ONLY the customer fields
// (productId + promoPriceCentavos + headline — never the internal id / timestamps /
// active flag); a 30s public Cache-Control header is set.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const mockGetForDate = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createDailySpecialService: () => ({ getForDate: mockGetForDate }),
}));

async function buildServer(): Promise<FastifyInstance> {
  const { specialsRoutes } = await import("../specials.js");
  const app = Fastify({ logger: false });
  await app.register(specialsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESTAURANT_TIMEZONE = "America/Sao_Paulo";
});
afterEach(() => vi.resetModules());

describe("GET /api/specials/today — public daily specials", () => {
  it("returns today's active specials, projecting ONLY the customer fields", async () => {
    // getForDate returns full DailySpecial rows; the route must not leak internals.
    mockGetForDate.mockResolvedValue([
      {
        id: "spc_1",
        medusaProductId: "prod_feijoada",
        date: "2026-07-04",
        promoPriceCentavos: 4900,
        headline: "Feijoada da casa",
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const server = await buildServer();
    try {
      const res = await server.inject({ method: "GET", url: "/api/specials/today" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { specials: Array<Record<string, unknown>> };
      expect(body.specials).toEqual([
        { productId: "prod_feijoada", promoPriceCentavos: 4900, headline: "Feijoada da casa" },
      ]);
      // No internal fields leak.
      const row = body.specials[0]!;
      expect(row).not.toHaveProperty("id");
      expect(row).not.toHaveProperty("date");
      expect(row).not.toHaveProperty("active");
      expect(row).not.toHaveProperty("createdAt");
    } finally {
      await server.close();
    }
  });

  it("reads for today in RESTAURANT_TIMEZONE and sets a 30s public cache header", async () => {
    mockGetForDate.mockResolvedValue([]);
    const server = await buildServer();
    try {
      const res = await server.inject({ method: "GET", url: "/api/specials/today" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ specials: [] });
      expect(res.headers["cache-control"]).toBe("public, max-age=30");
      // getForDate was called with a YYYY-MM-DD date string (today in restaurant tz).
      expect(mockGetForDate).toHaveBeenCalledTimes(1);
      expect(mockGetForDate.mock.calls[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await server.close();
    }
  });

  it("requires no auth (no staff preHandler) — a public request is served", async () => {
    mockGetForDate.mockResolvedValue([]);
    const server = await buildServer();
    try {
      // No Authorization header / no staff context injected — still 200.
      const res = await server.inject({ method: "GET", url: "/api/specials/today" });
      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
