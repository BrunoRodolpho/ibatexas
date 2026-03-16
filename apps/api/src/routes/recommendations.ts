/**
 * Recommendations API routes.
 *
 * Exposes the intelligence backend (co-purchase, personalized recs)
 * as REST endpoints for the frontend recommendations domain.
 *
 * GET /api/recommendations            — personalized (auth optional)
 * GET /api/recommendations/also-added — co-purchase for a product
 */

import type { FastifyInstance } from "fastify";
import { Channel, type AgentContext } from "@ibatexas/types";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getRecommendations, getAlsoAdded } from "@ibatexas/tools";
import { optionalAuth } from "../middleware/auth.js";

/** Build a minimal AgentContext for recommendation routes (no session/agent needed). */
function buildRecsContext(customerId?: string): AgentContext {
  return { channel: Channel.Web, sessionId: "rest-api", userType: customerId ? "customer" : "guest", customerId };
}

const RecsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(6),
  context: z.string().max(500).optional(),
});

const AlsoAddedQuery = z.object({
  productId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional().default(6),
});

export async function recommendationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/recommendations ──────────────────────────────────────────
  app.get(
    "/api/recommendations",
    {
      preHandler: [optionalAuth],
      schema: { querystring: RecsQuery },
    },
    async (request) => {
      const { limit, context } = request.query;
      const customerId = (request as { customerId?: string }).customerId;

      const result = await getRecommendations(
        { context, limit },
        buildRecsContext(customerId),
      );

      return {
        products: result.products,
        label: result.message ?? "Recomendado para você",
      };
    },
  );

  // ── GET /api/recommendations/also-added ───────────────────────────────
  app.get(
    "/api/recommendations/also-added",
    {
      schema: { querystring: AlsoAddedQuery },
    },
    async (request) => {
      const { productId, limit } = request.query;

      const result = await getAlsoAdded(
        { productId, limit },
        buildRecsContext(),
      );

      return {
        products: result.products,
        label: result.label ?? "Clientes também adicionam",
      };
    },
  );
}
