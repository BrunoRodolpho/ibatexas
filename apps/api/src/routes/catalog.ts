// Catalog routes
//
// GET /api/products          — search products via Typesense
// GET /api/products/:id      — get full product detail by ID
// GET /api/categories        — list categories from Medusa store API

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { Channel } from "@ibatexas/types";
import { searchProducts, getProductDetails } from "@ibatexas/tools";

const ProductsQuery = z.object({
  query: z.string().min(1).max(200).optional(),
  tags: z.string().optional(), // comma-separated
  availableNow: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  productType: z.enum(["food", "frozen", "merchandise"]).optional(),
  categoryHandle: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const ProductParams = z.object({
  id: z.string().min(1),
});

export async function catalogRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/products ──────────────────────────────────────────────────────

  app.get(
    "/api/products",
    {
      schema: {
        tags: ["catalog"],
        summary: "Buscar produtos",
        querystring: ProductsQuery,
      },
    },
    async (request, reply) => {
      const { query, tags, availableNow, productType, categoryHandle, limit } = request.query;

      const tagList = tags
        ? tags.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;

      const result = await searchProducts(
        {
          query: query ?? "*",
          tags: tagList,
          availableNow: availableNow ?? false,
          productType,
          categoryHandle,
          limit,
        },
        {
          channel: Channel.Web,
          sessionId: "catalog",
          userType: "guest",
        },
      );

      return reply.send({
        products: result.products,
        totalFound: result.totalFound,
        searchModel: result.searchModel,
      });
    },
  );

  // ── GET /api/products/:id ──────────────────────────────────────────────────

  app.get(
    "/api/products/:id",
    {
      schema: {
        tags: ["catalog"],
        summary: "Detalhe de produto",
        params: ProductParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const product = await getProductDetails(id);

      if (!product) {
        return reply
          .status(404)
          .send({ statusCode: 404, error: "Not Found", message: "Produto não encontrado." });
      }

      return reply.send(product);
    },
  );

  // ── GET /api/categories ────────────────────────────────────────────────────

  app.get(
    "/api/categories",
    {
      schema: {
        tags: ["catalog"],
        summary: "Listar categorias",
      },
    },
    async (_request, reply) => {
      const medusaUrl =
        process.env.MEDUSA_URL ?? "http://localhost:9000";
      const publishableKey = process.env.MEDUSA_PUBLISHABLE_KEY ?? "";

      let categories: unknown[] = [];
      try {
        const res = await fetch(
          `${medusaUrl}/store/product-categories`,
          {
            headers: {
              "x-publishable-api-key": publishableKey,
            },
          },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            product_categories?: unknown[];
          };
          categories = data.product_categories ?? [];
        } else {
          server.log.warn(`[catalog] Medusa categories returned ${res.status}`);
        }
      } catch (err) {
        server.log.error(err, "[catalog] Failed to fetch categories from Medusa");
      }

      return reply.send({ categories });
    },
  );
}
