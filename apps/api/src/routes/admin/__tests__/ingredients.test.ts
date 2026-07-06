// admin/ingredients.ts — the manager-gated raw-ingredient inventory surface
// (NEW-003 stock slice). Locks: requireManagerRole fail-closes (403) on every
// route; GET list threads activeOnly; POST 201 with the created row + body
// validation; PATCH/DELETE/adjust return 200 with the row, 404-only-when-missing;
// adjust threads a (possibly negative) deltaMilli; low-stock returns the read.
//
// Harness mirrors schedule-shifts.test.ts: an instance-level preHandler injects
// the staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockList = vi.hoisted(() => vi.fn());
const mockLowStock = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockAdjust = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createIngredientService: () => ({
    list: mockList,
    listLowStock: mockLowStock,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
    adjustStock: mockAdjust,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { ingredientRoutes } = await import("../ingredients.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(ingredientRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/ingredients is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ingredients" });
      expect(res.statusCode).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { ingredients } and lists all (activeOnly false) by default", async () => {
    mockList.mockResolvedValue([{ id: "ing_1", name: "Farinha" }]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ingredients" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ingredients: Array<{ id: string }> };
      expect(body.ingredients.map((i) => i.id)).toEqual(["ing_1"]);
      expect(mockList).toHaveBeenCalledWith({ activeOnly: false });
    } finally {
      await server.close();
    }
  });

  it("threads activeOnly=true to the service", async () => {
    mockList.mockResolvedValue([]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/ingredients?activeOnly=true",
      });
      expect(res.statusCode).toBe(200);
      expect(mockList).toHaveBeenCalledWith({ activeOnly: true });
    } finally {
      await server.close();
    }
  });

  it("treats activeOnly=false as list-all (string false is NOT truthy)", async () => {
    mockList.mockResolvedValue([]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/ingredients?activeOnly=false",
      });
      expect(res.statusCode).toBe(200);
      expect(mockList).toHaveBeenCalledWith({ activeOnly: false });
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/ingredients/low-stock", () => {
  it("rejects ATTENDANT with 403 and never reads", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ingredients/low-stock" });
      expect(res.statusCode).toBe(403);
      expect(mockLowStock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { ingredients } from listLowStock (not parsed as an id)", async () => {
    mockLowStock.mockResolvedValue([{ id: "low_1", stockMilli: 100, lowStockMilli: 500 }]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ingredients/low-stock" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ingredients: Array<{ id: string }> };
      expect(body.ingredients.map((i) => i.id)).toEqual(["low_1"]);
      expect(mockLowStock).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/ingredients — create", () => {
  it("rejects ATTENDANT with 403 and never creates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients",
        payload: { name: "Farinha", unit: "kg" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("creates (201) and threads name/unit/quantities", async () => {
    mockCreate.mockResolvedValue({ id: "ing_1", name: "Farinha" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients",
        payload: { name: "Farinha", unit: "kg", stockMilli: 2500, lowStockMilli: 1000 },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { ingredient: { id: string } }).ingredient).toMatchObject({ id: "ing_1" });
      expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
        name: "Farinha",
        unit: "kg",
        stockMilli: 2500,
        lowStockMilli: 1000,
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an unknown unit with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients",
        payload: { name: "Farinha", unit: "quilos" },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a negative stockMilli with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients",
        payload: { name: "Farinha", unit: "kg", stockMilli: -1 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("threads costCentavosPerUnit (NEW-035) and rejects a negative cost with 400", async () => {
    mockCreate.mockResolvedValue({ id: "ing_c", name: "Farinha" });
    const server = await buildServer(MANAGER);
    try {
      const ok = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients",
        payload: { name: "Farinha", unit: "kg", costCentavosPerUnit: 450 },
      });
      expect(ok.statusCode).toBe(201);
      expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ costCentavosPerUnit: 450 });

      const bad = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients",
        payload: { name: "Farinha", unit: "kg", costCentavosPerUnit: -1 },
      });
      expect(bad.statusCode).toBe(400);
      expect(mockCreate).toHaveBeenCalledTimes(1); // the bad one never reached the service
    } finally {
      await server.close();
    }
  });
});

describe("PATCH /api/admin/ingredients/:id — update", () => {
  it("rejects ATTENDANT with 403 and never updates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/ingredients/ing_1",
        payload: { lowStockMilli: 800 },
      });
      expect(res.statusCode).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("updates and returns the row (200)", async () => {
    mockUpdate.mockResolvedValue({ id: "ing_1", lowStockMilli: 800 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/ingredients/ing_1",
        payload: { lowStockMilli: 800 },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ingredient: { id: string } }).ingredient).toMatchObject({ id: "ing_1" });
      expect(mockUpdate).toHaveBeenCalledWith("ing_1", { lowStockMilli: 800 });
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
        url: "/api/admin/ingredients/missing",
        payload: { lowStockMilli: 800 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "ingredient_not_found" });
    } finally {
      await server.close();
    }
  });

  it("accepts an explicit null costCentavosPerUnit to CLEAR the cost (NEW-035)", async () => {
    mockUpdate.mockResolvedValue({ id: "ing_1", costCentavosPerUnit: null });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/ingredients/ing_1",
        payload: { costCentavosPerUnit: null },
      });
      expect(res.statusCode).toBe(200);
      // null passes validation (nullable) and threads through as a defined clear.
      expect(mockUpdate).toHaveBeenCalledWith("ing_1", { costCentavosPerUnit: null });
    } finally {
      await server.close();
    }
  });
});

describe("DELETE /api/admin/ingredients/:id — remove", () => {
  it("rejects ATTENDANT with 403 and never deletes", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/ingredients/ing_1" });
      expect(res.statusCode).toBe(403);
      expect(mockRemove).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("deletes and returns the row (200)", async () => {
    mockRemove.mockResolvedValue({ id: "ing_1" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/ingredients/ing_1" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ingredient: { id: string } }).ingredient).toMatchObject({ id: "ing_1" });
      expect(mockRemove).toHaveBeenCalledWith("ing_1");
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (remove returns null)", async () => {
    mockRemove.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/ingredients/missing" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "ingredient_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/ingredients/:id/adjust — adjust stock", () => {
  it("rejects ATTENDANT with 403 and never adjusts", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients/ing_1/adjust",
        payload: { deltaMilli: 500 },
      });
      expect(res.statusCode).toBe(403);
      expect(mockAdjust).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("threads a positive deltaMilli and returns the row (200)", async () => {
    mockAdjust.mockResolvedValue({ id: "ing_1", stockMilli: 2500 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients/ing_1/adjust",
        payload: { deltaMilli: 500 },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ingredient: { stockMilli: number } }).ingredient).toMatchObject({ stockMilli: 2500 });
      expect(mockAdjust).toHaveBeenCalledWith("ing_1", 500);
    } finally {
      await server.close();
    }
  });

  it("threads a NEGATIVE deltaMilli (subtract stock)", async () => {
    mockAdjust.mockResolvedValue({ id: "ing_1", stockMilli: 0 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients/ing_1/adjust",
        payload: { deltaMilli: -1000 },
      });
      expect(res.statusCode).toBe(200);
      expect(mockAdjust).toHaveBeenCalledWith("ing_1", -1000);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-integer deltaMilli with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients/ing_1/adjust",
        payload: { deltaMilli: 1.5 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockAdjust).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (adjustStock returns null)", async () => {
    mockAdjust.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ingredients/missing/adjust",
        payload: { deltaMilli: 500 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "ingredient_not_found" });
    } finally {
      await server.close();
    }
  });
});
