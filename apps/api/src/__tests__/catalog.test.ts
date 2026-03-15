// Unit tests for catalog routes
// GET /api/products, GET /api/products/:id, GET /api/categories

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Channel, AvailabilityWindow, ProductType, type ProductDTO } from "@ibatexas/types";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSearchProducts = vi.hoisted(() => vi.fn());
const mockGetProductDetails = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  searchProducts: mockSearchProducts,
  getProductDetails: mockGetProductDetails,
}));

// ── Server factory ─────────────────────────────────────────────────────────────

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { catalogRoutes } from "../routes/catalog.js";

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(catalogRoutes);
  await app.ready();
  return app;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const MOCK_PRODUCT: ProductDTO = {
  id: "prod_01JN",
  title: "Costela Defumada",
  description: "Costela bovina defumada lentamente",
  price: 8900,
  imageUrl: null,
  images: [],
  tags: ["popular"],
  availabilityWindow: AvailabilityWindow.JANTAR,
  allergens: [],
  variants: [{ id: "var_01", title: "Individual", sku: "CST-IND", price: 8900 }],
  productType: ProductType.FOOD,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("GET /api/products", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns product list from searchProducts", async () => {
    mockSearchProducts.mockResolvedValue({
      products: [MOCK_PRODUCT],
      totalFound: 1,
      searchModel: "hybrid",
      hitCache: false,
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/products?query=costela",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      items: ProductDTO[];
      total: number;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Costela Defumada");
    expect(body.total).toBe(1);

    expect(mockSearchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ query: "costela" }),
      expect.objectContaining({ channel: Channel.Web }),
    );
  });

  it("passes tags as an array when comma-separated", async () => {
    mockSearchProducts.mockResolvedValue({
      products: [],
      totalFound: 0,
      searchModel: "keyword",
      hitCache: false,
    });

    const app = await buildTestServer();
    await app.inject({
      method: "GET",
      url: "/api/products?query=frango&tags=popular,vegetariano",
    });

    expect(mockSearchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["popular", "vegetariano"] }),
      expect.anything(),
    );
  });
});

describe("GET /api/products/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns product detail when found", async () => {
    mockGetProductDetails.mockResolvedValue(MOCK_PRODUCT);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/products/prod_01JN",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ProductDTO;
    expect(body.id).toBe("prod_01JN");
    expect(body.title).toBe("Costela Defumada");
  });

  it("returns 404 when product not found", async () => {
    mockGetProductDetails.mockResolvedValue(null);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/products/unknown_id",
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { message: string };
    expect(body.message).toContain("Produto não encontrado");
  });
});

describe("GET /api/categories", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns categories from Medusa", async () => {
    const mockCategories = [
      { id: "cat_01", name: "Entradas", handle: "entradas", parent_category_id: null },
      { id: "cat_02", name: "Pratos Principais", handle: "pratos-principais", parent_category_id: null },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ product_categories: mockCategories }),
      }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/categories",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { categories: unknown[] };
    expect(body.categories).toHaveLength(2);
    expect((body.categories[0] as { name: string }).name).toBe("Entradas");
  });

  it("returns empty array when Medusa is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/categories",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { categories: unknown[] };
    expect(body.categories).toHaveLength(0);
  });
});
