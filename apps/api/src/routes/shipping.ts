// Shipping routes
//
// GET /api/shipping/estimate?cep=... — get shipping estimates for CEP

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { SHIPPING_RATES, SHIPPING_RATE_DEFAULT } from "@ibatexas/types";

const ShippingQuery = z.object({
  cep: z.string().min(8).max(8).regex(/^\d{8}$/, "CEP deve ter exatamente 8 dígitos"),
});

interface ShippingOption {
  service: "PAC" | "SEDEX";
  price: number; // centavos
  estimatedDays: number;
}

export async function shippingRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/shipping/estimate ─────────────────────────────────────────────

  app.get(
    "/api/shipping/estimate",
    {
      schema: {
        tags: ["shipping"],
        summary: "Estimar frete por CEP",
        querystring: ShippingQuery,
      },
    },
    async (request, reply) => {
      const { cep } = request.query;

      // Get first digit of CEP to determine region
      const firstDigit = parseInt(cep.charAt(0), 10);
      const rates = SHIPPING_RATES[firstDigit] ?? SHIPPING_RATE_DEFAULT;

      const options: ShippingOption[] = [
        {
          service: "PAC",
          price: rates.pac.price,
          estimatedDays: rates.pac.days,
        },
        {
          service: "SEDEX",
          price: rates.sedex.price,
          estimatedDays: rates.sedex.days,
        },
      ];

      return reply.status(200).send({
        success: true,
        data: { options },
      });
    }
  );
}