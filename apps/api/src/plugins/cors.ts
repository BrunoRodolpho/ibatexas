import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export async function registerCors(server: FastifyInstance): Promise<void> {
  await server.register(cors, {
    origin: process.env.NODE_ENV === "production"
      ? [process.env.WEB_URL ?? "https://ibatexas.com.br"]
      : true,
    credentials: true,
  });
}
