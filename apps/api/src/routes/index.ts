import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { chatRoutes } from "./chat.js";
import { catalogRoutes } from "./catalog.js";
import { shippingRoutes } from "./shipping.js";
import { adminRoutes } from "./admin.js";

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  await server.register(healthRoutes);
  await server.register(chatRoutes);
  await server.register(catalogRoutes);
  await server.register(shippingRoutes);
  await server.register(adminRoutes);
}
