// Admin routes
//
// GET  /api/admin/dashboard      — aggregated KPI metrics
// GET  /api/admin/products        — proxy Medusa admin products list
// PATCH /api/admin/products/:id   — proxy Medusa admin product update
// GET  /api/admin/orders          — proxy Medusa admin orders list
// PATCH /api/admin/orders/:id     — proxy Medusa admin order update

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const MEDUSA_URL = process.env.MEDUSA_URL ?? "http://localhost:9000";
const MEDUSA_API_KEY = process.env.MEDUSA_API_KEY ?? "";

async function medusaAdmin(path: string, options?: RequestInit) {
  const url = `${MEDUSA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-medusa-access-token": MEDUSA_API_KEY,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Medusa admin error ${res.status}: ${text}`);
  }
  return res.json();
}

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

const OrdersAdminQuery = z.object({
  status: z.string().optional(),
  payment_status: z.string().optional(),
  fulfillment_status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const OrderParams = z.object({ id: z.string().min(1) });

const OrderPatchBody = z.object({
  fulfillment_status: z.string().optional(),
  payment_status: z.string().optional(),
});

export async function adminRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/admin/dashboard ───────────────────────────────────────────────
  app.get(
    "/api/admin/dashboard",
    { schema: { tags: ["admin"], summary: "Métricas do painel" } },
    async (_request, reply) => {
      try {
        // Fetch today's orders from Medusa
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = today.toISOString();

        const qs = new URLSearchParams({
          created_at: JSON.stringify({ gte: todayIso }),
          limit: "500",
          offset: "0",
          fields: "id,total,status",
        });

        let ordersToday = 0;
        let revenueToday = 0;

        try {
          const data = await medusaAdmin(`/admin/orders?${qs}`);
          const orders: { id: string; total: number; status: string }[] =
            data.orders ?? [];
          ordersToday = orders.length;
          revenueToday = orders.reduce(
            (sum: number, o) => sum + (o.total ?? 0),
            0,
          );
        } catch {
          // Medusa not running in test mode — return zeros
        }

        return reply.send({
          ordersToday,
          revenueToday,
          activeReservations: 0, // populated in Step 8
          pendingEscalations: 0, // populated in Step 9
        });
      } catch (err) {
        reply.code(500).send({ error: "Failed to load dashboard" });
      }
    },
  );

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
        expand: "variants,categories,tags",
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
          variants: { id: string }[];
          categories: { handle: string; name: string }[];
        }[];

        const rows = products
          .filter((p) => {
            if (!productType) return true;
            return (
              (p.metadata?.productType ?? "food") === productType
            );
          })
          .map((p) => ({
            id: p.id,
            title: p.title,
            handle: p.handle,
            imageUrl: p.thumbnail,
            category: p.categories?.[0]?.name ?? "—",
            price: 0, // price set comes via Remote Link — enriched client-side
            status: p.status,
            productType: (p.metadata?.productType ?? "food") as string,
            variantCount: p.variants?.length ?? 0,
            inStock: p.metadata?.inStock !== false,
          }));

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

  // ── GET /api/admin/orders ──────────────────────────────────────────────────
  app.get(
    "/api/admin/orders",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar pedidos (admin)",
        querystring: OrdersAdminQuery,
      },
    },
    async (request, reply) => {
      const { status, payment_status, fulfillment_status, limit, offset } =
        request.query;

      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        fields:
          "id,display_id,email,customer,items,total,status,payment_status,fulfillment_status,created_at",
        expand: "items,customer",
      });
      if (status) qs.set("status[]", status);
      if (payment_status) qs.set("payment_status[]", payment_status);
      if (fulfillment_status) qs.set("fulfillment_status[]", fulfillment_status);

      try {
        const data = await medusaAdmin(`/admin/orders?${qs}`);
        return reply.send({ orders: data.orders ?? [], count: data.count ?? 0 });
      } catch (err) {
        reply.code(502).send({ error: "Failed to fetch orders from Medusa" });
      }
    },
  );

  // ── PATCH /api/admin/orders/:id ───────────────────────────────────────────
  app.patch(
    "/api/admin/orders/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Atualizar pedido (admin)",
        params: OrderParams,
        body: OrderPatchBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      try {
        const data = await medusaAdmin(`/admin/orders/${id}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return reply.send({ order: data.order });
      } catch (err) {
        reply.code(502).send({ error: "Failed to update order" });
      }
    },
  );
}
