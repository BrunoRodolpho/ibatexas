// Admin routes
//
// GET  /api/admin/dashboard             — aggregated KPI metrics
// GET  /api/admin/products              — proxy Medusa admin products list
// PATCH /api/admin/products/:id         — proxy Medusa admin product update
// GET  /api/admin/products/:id          — proxy Medusa admin product detail
// GET  /api/admin/orders                — proxy Medusa admin orders list
// PATCH /api/admin/orders/:id           — proxy Medusa admin order update
// GET  /api/admin/reservations          — list all reservations
// POST /api/admin/reservations/:id/checkin    — check in guest
// POST /api/admin/reservations/:id/complete   — mark completed
// GET  /api/admin/tables                — list all tables
// POST /api/admin/tables                — create/update table
// POST /api/admin/timeslots             — generate time slots for a date range

import type { FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";
import { productRoutes } from "./products.js";
import { orderRoutes } from "./orders.js";
import { reservationRoutes } from "./reservations.js";
import { tableRoutes } from "./tables.js";

export async function adminRoutes(server: FastifyInstance): Promise<void> {
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "";

  // Auth guard — require x-admin-key header on every admin route
  server.addHook("preHandler", async (request, reply) => {
    if (!ADMIN_API_KEY) {
      return reply.code(503).send({ error: "Admin API key not configured" });
    }
    const key = request.headers["x-admin-key"];
    if (typeof key !== "string" || key.length === 0 || key !== ADMIN_API_KEY) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Register all admin sub-routes
  await server.register(dashboardRoutes);
  await server.register(productRoutes);
  await server.register(orderRoutes);
  await server.register(reservationRoutes);
  await server.register(tableRoutes);
}
