import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

export async function registerRateLimit(server: FastifyInstance): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const maxRequests = process.env.RATE_LIMIT_MAX
    ? Number(process.env.RATE_LIMIT_MAX)
    : isProduction ? 30 : 200;
  await server.register(rateLimit, {
    max: maxRequests,
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
