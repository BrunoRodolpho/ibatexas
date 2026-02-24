// Admin routes
//
// GET  /api/admin/dashboard             — aggregated KPI metrics
// GET  /api/admin/products              — proxy Medusa admin products list
// PATCH /api/admin/products/:id         — proxy Medusa admin product update
// GET  /api/admin/orders                — proxy Medusa admin orders list
// PATCH /api/admin/orders/:id           — proxy Medusa admin order update
// GET  /api/admin/reservations          — list all reservations
// POST /api/admin/reservations/:id/checkin    — check in guest
// POST /api/admin/reservations/:id/complete   — mark completed
// GET  /api/admin/tables                — list all tables
// POST /api/admin/tables                — create/update table
// POST /api/admin/timeslots             — generate time slots for a date range

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

        let activeReservations = 0
        try {
          const { prisma } = await import("@ibatexas/domain")
          activeReservations = await prisma.reservation.count({
            where: {
              status: { in: ["pending", "confirmed", "seated"] },
              timeSlot: { date: { gte: new Date() } },
            },
          })
        } catch {
          // domain DB not yet migrated — return 0
        }

        return reply.send({
          ordersToday,
          revenueToday,
          activeReservations,
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
          `/admin/products/${id}?expand=variants,categories,tags`,
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

        return reply.send({
          product: {
            id: p.id,
            title: p.title,
            handle: p.handle,
            description: p.description,
            imageUrl: p.thumbnail,
            category: p.categories?.[0]?.name ?? "—",
            price: 0,
            status: p.status,
            productType: (p.metadata?.productType ?? "food") as string,
            variantCount: p.variants?.length ?? 0,
            inStock: p.metadata?.inStock !== false,
            tags: (p.tags ?? []).map((t) => t.value),
            variants: (p.variants ?? []).map((v) => ({
              id: v.id,
              title: v.title,
              sku: v.sku,
              price:
                v.prices?.find((pr) => pr.currency_code === "brl")?.amount ??
                0,
              inventoryQuantity: v.inventory_quantity,
              allowBackorder: v.allow_backorder,
              manageInventory: v.manage_inventory,
            })),
          },
        });
      } catch (err) {
        reply.code(502).send({ error: "Failed to fetch product detail" });
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

  // ── Admin reservation endpoints ────────────────────────────────────────────

  // GET /api/admin/reservations
  app.get(
    "/api/admin/reservations",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar todas as reservas (admin)",
        querystring: z.object({
          date: z.string().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional().default(50),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      },
    },
    async (request, reply) => {
      try {
        const { prisma } = await import("@ibatexas/domain")
        const { date, status, limit, offset } = request.query as {
          date?: string
          status?: string
          limit: number
          offset: number
        }

        const where: Record<string, unknown> = {}
        if (status) where.status = status
        if (date) where.timeSlot = { date: new Date(date + "T00:00:00.000Z") }

        const [reservations, total] = await Promise.all([
          prisma.reservation.findMany({
            where,
            include: { timeSlot: true, tables: { include: { table: true } } },
            orderBy: [{ timeSlot: { date: "asc" } }, { timeSlot: { startTime: "asc" } }],
            take: limit,
            skip: offset,
          }),
          prisma.reservation.count({ where }),
        ])

        return reply.send({ reservations, total })
      } catch (err) {
        reply.code(500).send({ error: "Failed to fetch reservations" })
      }
    },
  )

  // POST /api/admin/reservations/:id/checkin
  app.post(
    "/api/admin/reservations/:id/checkin",
    {
      schema: {
        tags: ["admin"],
        summary: "Check-in do hóspede (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      try {
        const { prisma } = await import("@ibatexas/domain")
        const { id } = request.params as { id: string }
        const updated = await prisma.reservation.update({
          where: { id },
          data: { status: "seated", checkedInAt: new Date() },
        })
        return reply.send({ reservation: updated })
      } catch (err) {
        reply.code(500).send({ error: "Failed to check in reservation" })
      }
    },
  )

  // POST /api/admin/reservations/:id/complete
  app.post(
    "/api/admin/reservations/:id/complete",
    {
      schema: {
        tags: ["admin"],
        summary: "Marcar reserva como concluída (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      try {
        const { prisma } = await import("@ibatexas/domain")
        const { id } = request.params as { id: string }
        const updated = await prisma.reservation.update({
          where: { id },
          data: { status: "completed" },
        })
        return reply.send({ reservation: updated })
      } catch (err) {
        reply.code(500).send({ error: "Failed to complete reservation" })
      }
    },
  )

  // GET /api/admin/tables
  app.get(
    "/api/admin/tables",
    {
      schema: { tags: ["admin"], summary: "Listar mesas (admin)" },
    },
    async (_request, reply) => {
      try {
        const { prisma } = await import("@ibatexas/domain")
        const tables = await prisma.table.findMany({ orderBy: { number: "asc" } })
        return reply.send({ tables })
      } catch (err) {
        reply.code(500).send({ error: "Failed to fetch tables" })
      }
    },
  )

  // POST /api/admin/tables
  app.post(
    "/api/admin/tables",
    {
      schema: {
        tags: ["admin"],
        summary: "Criar ou atualizar mesa (admin)",
        body: z.object({
          number: z.string(),
          capacity: z.number().int().min(1),
          location: z.enum(["indoor", "outdoor", "bar", "terrace"]),
          accessible: z.boolean().optional().default(false),
          active: z.boolean().optional().default(true),
        }),
      },
    },
    async (request, reply) => {
      try {
        const { prisma } = await import("@ibatexas/domain")
        const body = request.body as {
          number: string
          capacity: number
          location: "indoor" | "outdoor" | "bar" | "terrace"
          accessible: boolean
          active: boolean
        }
        const table = await prisma.table.upsert({
          where: { number: body.number },
          update: {
            capacity: body.capacity,
            location: body.location,
            accessible: body.accessible,
            active: body.active,
          },
          create: body,
        })
        return reply.status(201).send({ table })
      } catch (err) {
        reply.code(500).send({ error: "Failed to upsert table" })
      }
    },
  )

  // POST /api/admin/timeslots — generate time slots for a date range
  app.post(
    "/api/admin/timeslots",
    {
      schema: {
        tags: ["admin"],
        summary: "Gerar horários para um intervalo de datas (admin)",
        body: z.object({
          fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          startTimes: z.array(z.string()).min(1),
          maxCovers: z.number().int().min(1),
          durationMinutes: z.number().int().min(30).optional().default(90),
        }),
      },
    },
    async (request, reply) => {
      try {
        const { prisma } = await import("@ibatexas/domain")
        const body = request.body as {
          fromDate: string
          toDate: string
          startTimes: string[]
          maxCovers: number
          durationMinutes: number
        }

        const from = new Date(body.fromDate + "T00:00:00.000Z")
        const to = new Date(body.toDate + "T00:00:00.000Z")
        let created = 0
        const current = new Date(from)

        while (current <= to) {
          for (const startTime of body.startTimes) {
            const existing = await prisma.timeSlot.findUnique({
              where: { date_startTime: { date: new Date(current), startTime } },
            })
            if (!existing) {
              await prisma.timeSlot.create({
                data: {
                  date: new Date(current),
                  startTime,
                  maxCovers: body.maxCovers,
                  durationMinutes: body.durationMinutes,
                },
              })
              created++
            }
          }
          current.setUTCDate(current.getUTCDate() + 1)
        }

        return reply.send({ created })
      } catch (err) {
        reply.code(500).send({ error: "Failed to generate time slots" })
      }
    },
  )
}
