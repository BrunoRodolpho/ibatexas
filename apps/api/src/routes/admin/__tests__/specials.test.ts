// admin/specials.ts — the manager-gated daily-specials / promo-of-the-day surface
// (NEW-005 ADMIN AUTHORING slice). Locks: requireManagerRole fail-closes (403) on every
// route; GET list threads date + activeOnly; GET /today reads getForDate(todayInTz);
// POST 201 with the created row + body validation (YMD date, non-negative promo price);
// PATCH/DELETE return 200 with the row, 404-only-when-missing.
//
// Harness mirrors ingredients.test.ts: an instance-level preHandler injects the staff
// identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockList = vi.hoisted(() => vi.fn());
const mockGetForDate = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createDailySpecialService: () => ({
    list: mockList,
    getForDate: mockGetForDate,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { specialRoutes } = await import("../specials.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(specialRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/specials is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/specials" });
      expect(res.statusCode).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { specials } and lists all (activeOnly false, no date) by default", async () => {
    mockList.mockResolvedValue([{ id: "ds_1", medusaProductId: "prod_1" }]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/specials" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { specials: Array<{ id: string }> };
      expect(body.specials.map((s) => s.id)).toEqual(["ds_1"]);
      expect(mockList).toHaveBeenCalledWith({ activeOnly: false });
    } finally {
      await server.close();
    }
  });

  it("threads date + activeOnly=true to the service", async () => {
    mockList.mockResolvedValue([]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/specials?date=2026-07-04&activeOnly=true",
      });
      expect(res.statusCode).toBe(200);
      expect(mockList).toHaveBeenCalledWith({ date: "2026-07-04", activeOnly: true });
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed date query with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/specials?date=07-04-2026",
      });
      expect(res.statusCode).toBe(400);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/specials/today", () => {
  it("rejects ATTENDANT with 403 and never reads", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/specials/today" });
      expect(res.statusCode).toBe(403);
      expect(mockGetForDate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { date, specials } from getForDate (today, not parsed as an id)", async () => {
    mockGetForDate.mockResolvedValue([{ id: "ds_today" }]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/specials/today" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { date: string; specials: Array<{ id: string }> };
      expect(body.specials.map((s) => s.id)).toEqual(["ds_today"]);
      // date is a YYYY-MM-DD business-day label resolved in RESTAURANT_TIMEZONE.
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(mockGetForDate).toHaveBeenCalledWith(body.date);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/specials — create", () => {
  it("rejects ATTENDANT with 403 and never creates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/specials",
        payload: { medusaProductId: "prod_1", date: "2026-07-04" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("creates (201) and threads product/date/promo/headline", async () => {
    mockCreate.mockResolvedValue({ id: "ds_1", medusaProductId: "prod_1" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/specials",
        payload: {
          medusaProductId: "prod_1",
          date: "2026-07-04",
          promoPriceCentavos: 3900,
          headline: "Feijoada da casa com 20% off",
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { special: { id: string } }).special).toMatchObject({ id: "ds_1" });
      expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
        medusaProductId: "prod_1",
        date: "2026-07-04",
        promoPriceCentavos: 3900,
        headline: "Feijoada da casa com 20% off",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed date with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/specials",
        payload: { medusaProductId: "prod_1", date: "04/07/2026" },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a negative promoPriceCentavos with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/specials",
        payload: { medusaProductId: "prod_1", date: "2026-07-04", promoPriceCentavos: -1 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a non-integer promoPriceCentavos with 400 (money = integer centavos)", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/specials",
        payload: { medusaProductId: "prod_1", date: "2026-07-04", promoPriceCentavos: 39.5 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("PATCH /api/admin/specials/:id — update", () => {
  it("rejects ATTENDANT with 403 and never updates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/specials/ds_1",
        payload: { headline: "Novo" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("updates and returns the row (200)", async () => {
    mockUpdate.mockResolvedValue({ id: "ds_1", headline: "Novo" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/specials/ds_1",
        payload: { headline: "Novo" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { special: { id: string } }).special).toMatchObject({ id: "ds_1" });
      expect(mockUpdate).toHaveBeenCalledWith("ds_1", { headline: "Novo" });
    } finally {
      await server.close();
    }
  });

  it("accepts explicit null promoPriceCentavos + headline to CLEAR them", async () => {
    mockUpdate.mockResolvedValue({ id: "ds_1", promoPriceCentavos: null, headline: null });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/specials/ds_1",
        payload: { promoPriceCentavos: null, headline: null },
      });
      expect(res.statusCode).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith("ds_1", { promoPriceCentavos: null, headline: null });
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (update returns null)", async () => {
    mockUpdate.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/specials/missing",
        payload: { headline: "Novo" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "daily_special_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("DELETE /api/admin/specials/:id — remove", () => {
  it("rejects ATTENDANT with 403 and never deletes", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/specials/ds_1" });
      expect(res.statusCode).toBe(403);
      expect(mockRemove).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("deletes and returns the row (200)", async () => {
    mockRemove.mockResolvedValue({ id: "ds_1" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/specials/ds_1" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { special: { id: string } }).special).toMatchObject({ id: "ds_1" });
      expect(mockRemove).toHaveBeenCalledWith("ds_1");
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (remove returns null)", async () => {
    mockRemove.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/specials/missing" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "daily_special_not_found" });
    } finally {
      await server.close();
    }
  });
});
