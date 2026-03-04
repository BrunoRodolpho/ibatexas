// Catalog routes
//
// GET /api/products              — search products via Typesense
// GET /api/products/personalized — personalized feed (auth optional; falls back to global score)
// GET /api/products/:id          — get full product detail by ID
// GET /api/products/:id/reviews  — list reviews for a product
// GET /api/categories            — list categories from Medusa store API

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { Channel } from "@ibatexas/types";
import type { ProductVariant } from "@ibatexas/types";
import { searchProducts, getProductDetails, buildPersonalizedQuery } from "@ibatexas/tools";
import { medusaAdmin, medusaStore } from "./admin/_shared.js";
import { optionalAuth } from "../middleware/auth.js";
import { prisma } from "@ibatexas/domain";

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
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "rating_desc", "newest"]).optional(),
  excludeAllergens: z.string().optional(), // comma-separated list
  minPrice: z.coerce.number().int().min(0).optional(), // centavos
  maxPrice: z.coerce.number().int().min(0).optional(), // centavos
  minRating: z.coerce.number().min(0).max(5).optional(),
});

const ProductParams = z.object({
  id: z.string().min(1),
});

const PersonalizedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(10),
});

// Zod schemas for Medusa API response validation
const MedusaProductResponse = z.object({
  product: z.object({
    variants: z.array(z.object({
      id: z.string(),
      title: z.string(),
      sku: z.string().nullable(),
      price_set: z.object({
        prices: z.array(z.object({
          amount: z.number(),
          currency_code: z.string(),
        })).optional(),
      }).optional(),
    })),
  }).optional(),
});

const MedusaCategoriesResponse = z.object({
  product_categories: z.array(z.unknown()).optional(),
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
      const {
        query,
        tags,
        availableNow,
        productType,
        categoryHandle,
        limit,
        offset,
        sort,
        excludeAllergens,
        minPrice,
        maxPrice,
        minRating,
      } = request.query;

      const tagList = tags
        ? tags.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;

      const allergenList = excludeAllergens
        ? excludeAllergens.split(",").map((a) => a.trim()).filter(Boolean)
        : undefined;

      const result = await searchProducts(
        {
          query: query ?? "*",
          tags: tagList,
          availableNow: availableNow ?? false,
          productType,
          categoryHandle,
          limit,
          offset,
          sort,
          excludeAllergens: allergenList,
          minPrice,
          maxPrice,
          minRating,
        },
        {
          channel: Channel.Web,
          sessionId: "catalog",
          userType: "guest",
        },
      );

      return reply.send({
        items: result.products,
        total: result.totalFound,
        searchModel: result.searchModel,
        facetCounts: result.facetCounts ?? null,
      });
    },
  );

  // ── GET /api/products/personalized ────────────────────────────────────────

  app.get(
    "/api/products/personalized",
    {
      schema: {
        tags: ["catalog"],
        summary: "Feed personalizado de produtos",
        querystring: PersonalizedQuery,
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const { limit } = request.query;
      const customerId = (request as { customerId?: string }).customerId;

      const tsQuery = await buildPersonalizedQuery(customerId ?? "", limit);
      const { getTypesenseClient, typesenseDocToDTO, COLLECTION } = await import("@ibatexas/tools");
      const result = await getTypesenseClient()
        .collections<Record<string, unknown>>(COLLECTION)
        .documents()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Typesense SDK typing mismatch
        .search(tsQuery as any)
        .catch(() => null);

      if (!result) {
        return reply.send({ items: [], total: 0 });
      }

      const items = (result.hits ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Typesense hit document typing
        .map((h) => typesenseDocToDTO((h as any).document));

      return reply.send({ items, total: result.found ?? 0 });
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
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = (request as { customerId?: string }).customerId;
      const product = await getProductDetails(id, customerId);

      if (!product) {
        return reply
          .status(404)
          .send({ statusCode: 404, error: "Not Found", message: "Produto não encontrado." });
      }

      // Enrich with variant data from Medusa only if Typesense didn't provide them
      // (Typesense now stores variants via variantsJson field; this is a fallback)
      // Fallback: enrich from Medusa if Typesense has no variants or all prices are zero
      const needsEnrichment =
        !product.variants ||
        product.variants.length === 0 ||
        product.variants.every((v) => v.price === 0);
      if (needsEnrichment) {
        try {
          const data = await medusaAdmin(
            `/admin/products/${id}?fields=*,+variants,+variants.price_set,+variants.price_set.prices`,
          );
          const parsed = MedusaProductResponse.safeParse(data);
          if (parsed.success) {
            const medusaVariants = parsed.data.product?.variants ?? [];
            product.variants = medusaVariants.map((v): ProductVariant => ({
              id: v.id,
              title: v.title,
              sku: v.sku ?? null,
              // Medusa v2 stores in reais — convert to centavos
              price: Math.round(
                (v.price_set?.prices?.find((pr) => pr.currency_code === "brl")?.amount ?? 0) * 100
              ),
            }));
          } else {
            server.log.warn(`[catalog] Unexpected Medusa response shape for product ${id}`);
          }
        } catch (err) {
          server.log.warn(err, `[catalog] Failed to enrich variants for product ${id}`);
        }
      }

      return reply.send(product);
    },
  );

  // ── GET /api/products/:id/reviews ─────────────────────────────────────────

  app.get(
    "/api/products/:id/reviews",
    {
      schema: {
        tags: ["catalog"],
        summary: "Avaliações de um produto",
        params: ProductParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).optional().default(10),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { id: productId } = request.params;
      const { limit, offset } = request.query;

      const [reviews, total] = await Promise.all([
        prisma.review.findMany({
          where: { productId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          select: {
            id: true,
            rating: true,
            comment: true,
            createdAt: true,
            customer: {
              select: { name: true },
            },
          },
        }),
        prisma.review.count({ where: { productId } }),
      ]);

      const avg = reviews.length > 0
        ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
        : null;

      return reply.send({
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.createdAt.toISOString(),
          customerName: r.customer?.name ?? "Cliente",
        })),
        total,
        averageRating: avg,
      });
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
      let categories: unknown[] = [];
      try {
        const data = await medusaStore("/store/product-categories");
        const parsed = MedusaCategoriesResponse.safeParse(data);
        categories = parsed.success
          ? parsed.data.product_categories ?? []
          : [];
        if (!parsed.success) {
          server.log.warn("[catalog] Unexpected Medusa categories response shape");
        }
      } catch (err) {
        server.log.error(err, "[catalog] Failed to fetch categories from Medusa");
      }

      return reply.send({ categories });
    },
  );
}
