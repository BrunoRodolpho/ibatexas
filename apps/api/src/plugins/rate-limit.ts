import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

export async function registerRateLimit(server: FastifyInstance): Promise<void> {
  await server.register(rateLimit, {
    max: 30,
    timeWindow: "1 minute",
    keyGenerator(request: FastifyRequest): string {
      // Use sessionId from body for chat routes; fall back to IP
      const body = request.body as Record<string, unknown> | undefined;
      if (body?.sessionId && typeof body.sessionId === "string") {
        return `session:${body.sessionId}`;
      }
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
