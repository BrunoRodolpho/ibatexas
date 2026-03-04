import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { publishNatsEvent } from "@ibatexas/nats-client";

const TrackBody = z.object({
  event: z.string().min(1).max(100),
  properties: z.record(z.unknown()).optional(),
});

export async function analyticsRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/analytics/track",
    {
      schema: {
        tags: ["analytics"],
        summary: "Track web analytics event → NATS",
        body: TrackBody,
      },
      config: {
        // Analytics payloads should be small
        rawBody: false,
      },
      bodyLimit: 4096,
    },
    async (request, reply) => {
      const { event, properties } = request.body;

      // Fire-and-forget: publish to NATS, never block the client
      try {
        await publishNatsEvent(`web.${event}`, {
          ...properties,
          receivedAt: new Date().toISOString(),
        });
      } catch (err) {
        // Non-blocking: analytics must never block UX
        server.log.error(
          {
            eventType: event,
            sessionId: (properties as Record<string, unknown> | undefined)?.sessionId,
            error: String(err),
          },
          "[analytics] NATS publish failed",
        );
      }

      return reply.status(204).send();
    },
  );
}
