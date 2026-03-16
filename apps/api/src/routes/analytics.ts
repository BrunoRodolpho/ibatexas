import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { getRedisClient, rk } from "@ibatexas/tools";

// Whitelist of known analytics events — rejects unknown event names
const ALLOWED_EVENTS = new Set([
  'quick_add_clicked',
  'add_to_cart',
  'sticky_cta_used',
  'pdp_viewed',
  'product_card_clicked',
  'cross_sell_viewed',
  'cross_sell_added',
  'cart_drawer_opened',
  'checkout_started',
  'checkout_step_completed',
  'checkout_error',
  'checkout_abandoned',
  'checkout_completed',
  'session_started',
  'pdp_scroll_depth',
  'review_link_clicked',
  'storytelling_section_viewed',
  'filter_applied',
  'search_performed',
  'recently_viewed_clicked',
  'wishlist_toggled',
  'quick_view_opened',
  'cart_abandonment_nudge_shown',
  'cart_abandonment_nudge',
])

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

      // Validate event against whitelist
      if (!ALLOWED_EVENTS.has(event)) {
        return reply.status(400).send({ error: "Unknown event type" });
      }

      // Rate limit: 100 events per minute per IP
      try {
        const redis = await getRedisClient();
        const ip = request.ip;
        const rateLimitKey = rk(`analytics:rate:${ip}`);
        const count = await redis.incr(rateLimitKey);
        if (count === 1) {
          await redis.expire(rateLimitKey, 60); // 1 minute window
        }
        if (count > 100) {
          return reply.status(429).send({ error: "Rate limit exceeded" });
        }
      } catch {
        // If Redis fails, allow the event through (analytics should never block)
      }

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
            sessionId: properties?.sessionId,
            error: String(err),
          },
          "[analytics] NATS publish failed",
        );
      }

      return reply.status(204).send();
    },
  );
}
