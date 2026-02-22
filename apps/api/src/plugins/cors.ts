import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

function resolveOrigin(): string | true {
  if (process.env.NODE_ENV !== "production") {
    return true; // allow all origins in dev
  }
  const webUrl = process.env.WEB_URL;
  if (!webUrl) {
    throw new Error("WEB_URL environment variable is required in production");
  }
  return webUrl;
}

export async function registerCors(server: FastifyInstance): Promise<void> {
  await server.register(cors, {
    origin: resolveOrigin(),
    credentials: true,
  });
}
