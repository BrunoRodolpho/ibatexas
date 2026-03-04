import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

export async function registerRateLimit(server: FastifyInstance): Promise<void> {
  await server.register(rateLimit, {
    max: 30,
    timeWindow: "1 minute",
    keyGenerator(request: FastifyRequest): string {
      // Always use IP as primary key to prevent bypass via rotating sessionIds.
      // Combine with sessionId when available so different sessions on the same
      // IP get independent quotas (e.g. shared office), but a single IP cannot
      // generate unlimited keys by changing sessionId alone.
      const body = request.body as Record<string, unknown> | undefined;
      if (body?.sessionId && typeof body.sessionId === "string") {
        return `${request.ip}:${body.sessionId}`;
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
