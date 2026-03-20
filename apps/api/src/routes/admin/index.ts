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

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";
import { productRoutes } from "./products.js";
import { orderRoutes } from "./orders.js";
import { reservationRoutes } from "./reservations.js";
import { tableRoutes } from "./tables.js";
import { deliveryZoneRoutes } from "./delivery-zones.js";

export async function adminRoutes(server: FastifyInstance): Promise<void> {
  // Support comma-separated list of valid API keys for rotation
  const ADMIN_API_KEYS = (process.env.ADMIN_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  // Auth guard — require x-admin-key header on every admin route
  server.addHook("preHandler", async (request, reply) => {
    if (ADMIN_API_KEYS.length === 0) {
      return reply.code(503).send({ error: "Service unavailable" });
    }
    const key = request.headers["x-admin-key"];
    if (typeof key !== "string" || key.length === 0) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // Timing-safe comparison against all valid keys
    const keyBuf = Buffer.from(key);
    const isValid = ADMIN_API_KEYS.some((validKey) => {
      const expectedBuf = Buffer.from(validKey);
      if (keyBuf.length !== expectedBuf.length) return false;
      return timingSafeEqual(keyBuf, expectedBuf);
    });
    if (!isValid) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Audit logging — log all admin operations
  server.addHook("onResponse", async (request, reply) => {
    server.log.info({
      admin: true,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    }, "admin request");
  });

  // Register all admin sub-routes
  await server.register(dashboardRoutes);
  await server.register(productRoutes);
  await server.register(orderRoutes);
  await server.register(reservationRoutes);
  await server.register(tableRoutes);
  await server.register(deliveryZoneRoutes);
}
