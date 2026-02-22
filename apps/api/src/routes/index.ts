import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  await server.register(healthRoutes);
}
