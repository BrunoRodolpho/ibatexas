import sensible from "@fastify/sensible";
import type { FastifyInstance } from "fastify";

export async function registerSensible(server: FastifyInstance): Promise<void> {
  await server.register(sensible);
}
