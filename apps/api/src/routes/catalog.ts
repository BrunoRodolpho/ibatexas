// Catalog routes
//
// GET /api/products          — search products via Typesense
// GET /api/products/:id      — get full product detail by ID
// GET /api/categories        — list categories from Medusa store API

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { Channel } from "@ibatexas/types";
import type { ProductVariant } from "@ibatexas/types";
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

      // Enrich with variant data from Medusa only if Typesense didn't provide them
      // (Typesense now stores variants via variantsJson field; this is a fallback)
      // Fallback: enrich from Medusa if Typesense has no variants or all prices are zero
      const needsEnrichment =
        !product.variants ||
        product.variants.length === 0 ||
        product.variants.every((v) => v.price === 0);
      if (needsEnrichment) {
        try {
          const medusaUrl = process.env.MEDUSA_URL ?? "http://localhost:9000";
          const apiKey = process.env.MEDUSA_API_KEY ?? "";
          // Medusa v2 uses ?fields with + prefix for additional relations
          const res = await fetch(
            `${medusaUrl}/admin/products/${id}?fields=*,+variants,+variants.price_set,+variants.price_set.prices`,
            {
              headers: {
                "Content-Type": "application/json",
                "x-medusa-access-token": apiKey,
              },
            },
          );
          if (res.ok) {
            const data = (await res.json()) as {
              product: {
                variants: {
                  id: string;
                  title: string;
                  sku: string | null;
                  price_set?: {
                    prices?: { amount: number; currency_code: string }[];
                  };
                }[];
              };
            };
            const medusaVariants = data.product?.variants ?? [];
            product.variants = medusaVariants.map((v): ProductVariant => ({
              id: v.id,
              title: v.title,
              sku: v.sku ?? null,
              // Medusa v2 stores in reais — convert to centavos
              price: Math.round(
                (v.price_set?.prices?.find((pr) => pr.currency_code === "brl")?.amount ?? 0) * 100
              ),
            }));
          }
        } catch (err) {
          server.log.warn(err, `[catalog] Failed to enrich variants for product ${id}`);
        }
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
