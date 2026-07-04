// admin/recipes.ts — the manager-gated recipe/BOM + COGS surface (NEW-035). Locks:
// requireManagerRole fail-closes (403) on every route; GET list returns { recipes };
// POST 201 with the created row + body validation; GET /:id returns { recipe, cogs }
// and 404-only-when-missing; PUT /:id/ingredients replaces the BOM (404 when missing);
// DELETE returns the row / 404-when-missing; GET /:id/cogs returns { cogs } / 404.
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
const mockGet = vi.hoisted(() => vi.fn());
const mockGetByProduct = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockSetIngredients = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockGetCogs = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createRecipeService: () => ({
    list: mockList,
    get: mockGet,
    getByProduct: mockGetByProduct,
    create: mockCreate,
    setIngredients: mockSetIngredients,
    remove: mockRemove,
    getCogs: mockGetCogs,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { recipeRoutes } = await import("../recipes.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(recipeRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/recipes — list", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes" });
      expect(res.statusCode).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { recipes } for a MANAGER", async () => {
    mockList.mockResolvedValue([{ id: "rec_1", medusaProductId: "prod_1", ingredients: [] }]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { recipes: Array<{ id: string }> };
      expect(body.recipes.map((r) => r.id)).toEqual(["rec_1"]);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/recipes — create", () => {
  it("rejects ATTENDANT with 403 and never creates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/recipes",
        payload: { medusaProductId: "prod_1" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("creates (201) threading medusaProductId + yield + BOM lines", async () => {
    mockCreate.mockResolvedValue({ id: "rec_1", ingredients: [] });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/recipes",
        payload: {
          medusaProductId: "prod_1",
          yield: 10,
          lines: [{ ingredientId: "ing_1", qtyMilli: 2500 }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { recipe: { id: string } }).recipe).toMatchObject({ id: "rec_1" });
      expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
        medusaProductId: "prod_1",
        yield: 10,
        lines: [{ ingredientId: "ing_1", qtyMilli: 2500 }],
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a missing medusaProductId with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/recipes",
        payload: { yield: 4 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a non-positive qtyMilli line with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/recipes",
        payload: { medusaProductId: "prod_1", lines: [{ ingredientId: "ing_1", qtyMilli: 0 }] },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/recipes/:id — recipe + COGS", () => {
  it("rejects ATTENDANT with 403", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes/rec_1" });
      expect(res.statusCode).toBe(403);
      expect(mockGet).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { recipe, cogs } (COGS shape) when the recipe exists", async () => {
    mockGet.mockResolvedValue({ id: "rec_1", medusaProductId: "prod_1", ingredients: [] });
    mockGetCogs.mockResolvedValue({
      recipeId: "rec_1",
      medusaProductId: "prod_1",
      yield: 10,
      batchCogsCentavos: 4500,
      perServingCogsCentavos: 450,
      lines: [{ ingredientId: "ing_1", name: "Farinha", qtyMilli: 2500, lineCostCentavos: 1000, costMissing: false }],
      anyCostMissing: false,
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes/rec_1" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        recipe: { id: string };
        cogs: { batchCogsCentavos: number; perServingCogsCentavos: number; anyCostMissing: boolean };
      };
      expect(body.recipe).toMatchObject({ id: "rec_1" });
      expect(body.cogs).toMatchObject({
        batchCogsCentavos: 4500,
        perServingCogsCentavos: 450,
        anyCostMissing: false,
      });
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the recipe is missing (get returns null)", async () => {
    mockGet.mockResolvedValue(null);
    mockGetCogs.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes/missing" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "recipe_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/recipes/:id/cogs — COGS read", () => {
  it("rejects ATTENDANT with 403", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes/rec_1/cogs" });
      expect(res.statusCode).toBe(403);
      expect(mockGetCogs).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { cogs } with the batch + per-serving figures", async () => {
    mockGetCogs.mockResolvedValue({
      recipeId: "rec_1",
      medusaProductId: "prod_1",
      yield: 2,
      batchCogsCentavos: 800,
      perServingCogsCentavos: 400,
      lines: [],
      anyCostMissing: true,
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes/rec_1/cogs" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { cogs: { batchCogsCentavos: number; anyCostMissing: boolean } };
      expect(body.cogs).toMatchObject({ batchCogsCentavos: 800, perServingCogsCentavos: 400, anyCostMissing: true });
      expect(mockGetCogs).toHaveBeenCalledWith("rec_1");
    } finally {
      await server.close();
    }
  });

  it("404s when the recipe is missing (getCogs returns null)", async () => {
    mockGetCogs.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/recipes/missing/cogs" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "recipe_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("PUT /api/admin/recipes/:id/ingredients — replace the BOM", () => {
  it("rejects ATTENDANT with 403 and never writes", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "PUT",
        url: "/api/admin/recipes/rec_1/ingredients",
        payload: { lines: [{ ingredientId: "ing_1", qtyMilli: 100 }] },
      });
      expect(res.statusCode).toBe(403);
      expect(mockSetIngredients).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("replaces the BOM and returns { recipe } (200)", async () => {
    mockSetIngredients.mockResolvedValue({ id: "rec_1", ingredients: [{ ingredientId: "ing_1", qtyMilli: 3000 }] });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PUT",
        url: "/api/admin/recipes/rec_1/ingredients",
        payload: { lines: [{ ingredientId: "ing_1", qtyMilli: 3000 }] },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { recipe: { id: string } }).recipe).toMatchObject({ id: "rec_1" });
      expect(mockSetIngredients).toHaveBeenCalledWith("rec_1", [{ ingredientId: "ing_1", qtyMilli: 3000 }]);
    } finally {
      await server.close();
    }
  });

  it("accepts an empty lines array (clear the BOM)", async () => {
    mockSetIngredients.mockResolvedValue({ id: "rec_1", ingredients: [] });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PUT",
        url: "/api/admin/recipes/rec_1/ingredients",
        payload: { lines: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(mockSetIngredients).toHaveBeenCalledWith("rec_1", []);
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the recipe is missing (setIngredients returns null)", async () => {
    mockSetIngredients.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PUT",
        url: "/api/admin/recipes/missing/ingredients",
        payload: { lines: [] },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "recipe_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("DELETE /api/admin/recipes/:id — remove", () => {
  it("rejects ATTENDANT with 403 and never deletes", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/recipes/rec_1" });
      expect(res.statusCode).toBe(403);
      expect(mockRemove).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("deletes and returns the row (200)", async () => {
    mockRemove.mockResolvedValue({ id: "rec_1" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/recipes/rec_1" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { recipe: { id: string } }).recipe).toMatchObject({ id: "rec_1" });
      expect(mockRemove).toHaveBeenCalledWith("rec_1");
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (remove returns null)", async () => {
    mockRemove.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "DELETE", url: "/api/admin/recipes/missing" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "recipe_not_found" });
    } finally {
      await server.close();
    }
  });
});
