import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { medusaAdmin } from "./_shared.js";

const ProductsAdminQuery = z.object({
  q: z.string().optional(),
  category_id: z.string().optional(),
  productType: z.enum(["food", "frozen", "merchandise"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ProductParams = z.object({ id: z.string().min(1) });

const ProductPatchBody = z.object({
  status: z.enum(["published", "draft"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function productRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/products ────────────────────────────────────────────────
  app.get(
    "/api/admin/products",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar produtos (admin)",
        querystring: ProductsAdminQuery,
      },
    },
    async (request, reply) => {
      const { q, category_id, productType, limit, offset } = request.query;

      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        fields: "id,title,handle,thumbnail,status,metadata,variants,categories",
        expand: "variants,variants.prices,categories,tags",
      });
      if (q) qs.set("q", q);
      if (category_id) qs.set("category_id[]", category_id);

      try {
        const data = await medusaAdmin(`/admin/products?${qs}`);
        const products = (data.products ?? []) as {
          id: string;
          title: string;
          handle: string;
          thumbnail: string | null;
          status: string;
          metadata: Record<string, unknown> | null;
          variants: { id: string; prices?: { amount: number; currency_code: string }[] }[];
          categories: { handle: string; name: string }[];
        }[];

        const rows = products
          .filter((p) => {
            if (!productType) return true;
            return (
              (p.metadata?.productType ?? "food") === productType
            );
          })
          .map((p) => {
            // Extract the lowest BRL price from all variants
            // Medusa v2 stores in reais — convert to centavos (our convention)
            const brlPrices = (p.variants ?? [])
              .flatMap((v) => v.prices ?? [])
              .filter((pr) => pr.currency_code === "brl")
              .map((pr) => Math.round(pr.amount * 100));
            const price = brlPrices.length > 0 ? Math.min(...brlPrices) : 0;

            return {
              id: p.id,
              title: p.title,
              handle: p.handle,
              imageUrl: p.thumbnail,
              category: p.categories?.[0]?.name ?? "—",
              price,
              status: p.status,
              productType: (p.metadata?.productType ?? "food") as string,
              variantCount: p.variants?.length ?? 0,
              inStock: p.metadata?.inStock !== false,
            };
          });

        return reply.send({ products: rows, count: rows.length });
      } catch (err) {
        reply.code(502).send({ error: "Failed to fetch products from Medusa" });
      }
    },
  );

  // ── PATCH /api/admin/products/:id ─────────────────────────────────────────
  app.patch(
    "/api/admin/products/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Atualizar produto (admin)",
        params: ProductParams,
        body: ProductPatchBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      try {
        const data = await medusaAdmin(`/admin/products/${id}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return reply.send({ product: data.product });
      } catch (err) {
        reply.code(502).send({ error: "Failed to update product" });
      }
    },
  );

  // ── GET /api/admin/products/:id ─────────────────────────────────────────
  app.get(
    "/api/admin/products/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Detalhe do produto com variantes (admin)",
        params: ProductParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const data = await medusaAdmin(
          `/admin/products/${id}?expand=variants,variants.prices,categories,tags`,
        );
        const p = data.product as {
          id: string;
          title: string;
          handle: string;
          description: string | null;
          thumbnail: string | null;
          status: string;
          metadata: Record<string, unknown> | null;
          categories: { name: string }[];
          tags: { value: string }[];
          variants: {
            id: string;
            title: string;
            sku: string | null;
            inventory_quantity: number;
            allow_backorder: boolean;
            manage_inventory: boolean;
            prices: { amount: number; currency_code: string }[];
          }[];
        };

        const variantRows = (p.variants ?? []).map((v) => ({
              id: v.id,
              title: v.title,
              sku: v.sku,
              // Medusa v2 stores in reais — convert to centavos (our convention)
              price: Math.round(
                (v.prices?.find((pr) => pr.currency_code === "brl")?.amount ?? 0) * 100
              ),
              inventoryQuantity: v.inventory_quantity,
              allowBackorder: v.allow_backorder,
              manageInventory: v.manage_inventory,
            }));

        // Product-level price: lowest BRL variant price (already in centavos)
        const brlPrices = variantRows.map((v) => v.price).filter((p) => p > 0);
        const productPrice = brlPrices.length > 0 ? Math.min(...brlPrices) : 0;

        return reply.send({
          product: {
            id: p.id,
            title: p.title,
            handle: p.handle,
            description: p.description,
            imageUrl: p.thumbnail,
            category: p.categories?.[0]?.name ?? "—",
            price: productPrice,
            status: p.status,
            productType: (p.metadata?.productType ?? "food") as string,
            variantCount: p.variants?.length ?? 0,
            inStock: p.metadata?.inStock !== false,
            tags: (p.tags ?? []).map((t) => t.value),
            variants: variantRows,
          },
        });
      } catch (err) {
        reply.code(502).send({ error: "Failed to fetch product detail" });
      }
    },
  );
}
