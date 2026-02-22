import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

export async function registerHelmet(server: FastifyInstance): Promise<void> {
  await server.register(helmet);
}
