import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

export async function registerRateLimit(server: FastifyInstance): Promise<void> {
  await server.register(rateLimit, {
    max: 30,
    timeWindow: "1 minute",
    // Use IP alone as rate limit key to prevent bypass via sessionId rotation
    keyGenerator(request: FastifyRequest): string {
      return request.ip;
    },
    errorResponseBuilder() {
      return {
        statusCode: 429,
        error: "Too Many Requests",
        message: "Muitas mensagens. Aguarde um momento.",
      };
    },
  });
}
