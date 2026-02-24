// Shipping routes
//
// GET /api/shipping/estimate?cep=... — get shipping estimates for CEP

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

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
      
      // Static region-based rates (Phase 1)
      // Phase 2 will replace with Correios/EasyPost API integration
      const rates = getShippingRatesByRegion(firstDigit);

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

/**
 * Static shipping rates based on CEP first digit (region)
 * São Paulo state (1) = cheaper, other regions more expensive
 */
function getShippingRatesByRegion(firstDigit: number) {
  switch (firstDigit) {
    case 1: // São Paulo (SP)
      return {
        pac: { price: 1200, days: 3 },    // R$12,00 - 3 days
        sedex: { price: 2200, days: 1 },  // R$22,00 - 1 day
      };
    case 2: // Rio de Janeiro (RJ) / Espírito Santo (ES)
      return {
        pac: { price: 1800, days: 5 },    // R$18,00 - 5 days
        sedex: { price: 3200, days: 2 },  // R$32,00 - 2 days
      };
    case 3: // Minas Gerais (MG)
      return {
        pac: { price: 1500, days: 4 },    // R$15,00 - 4 days
        sedex: { price: 2800, days: 2 },  // R$28,00 - 2 days
      };
    case 4: // Bahia (BA) / Sergipe (SE)
      return {
        pac: { price: 2500, days: 7 },    // R$25,00 - 7 days
        sedex: { price: 4200, days: 3 },  // R$42,00 - 3 days
      };
    case 5: // Pernambuco (PE) / Alagoas (AL) / others
      return {
        pac: { price: 2800, days: 8 },    // R$28,00 - 8 days
        sedex: { price: 4800, days: 4 },  // R$48,00 - 4 days
      };
    case 6: // Ceará (CE) / others
      return {
        pac: { price: 3000, days: 9 },    // R$30,00 - 9 days
        sedex: { price: 5200, days: 4 },  // R$52,00 - 4 days
      };
    case 7: // Brasília (DF) / Goiás (GO) / Tocantins (TO)
      return {
        pac: { price: 2200, days: 6 },    // R$22,00 - 6 days
        sedex: { price: 3800, days: 3 },  // R$38,00 - 3 days
      };
    case 8: // Paraná (PR) / Santa Catarina (SC) / Rio Grande do Sul (RS)
      return {
        pac: { price: 1800, days: 5 },    // R$18,00 - 5 days
        sedex: { price: 3200, days: 2 },  // R$32,00 - 2 days
      };
    case 9: // Mato Grosso (MT) / others
      return {
        pac: { price: 2800, days: 8 },    // R$28,00 - 8 days
        sedex: { price: 4600, days: 4 },  // R$46,00 - 4 days
      };
    default: // Fallback for edge cases
      return {
        pac: { price: 2500, days: 7 },    // R$25,00 - 7 days
        sedex: { price: 4200, days: 3 },  // R$42,00 - 3 days
      };
  }
}