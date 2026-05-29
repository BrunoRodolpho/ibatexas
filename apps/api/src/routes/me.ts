// Me routes — LGPD data access and deletion
//
// GET    /api/me/data  — export all personal data (portability)
// DELETE /api/me/data  — anonymize personal data (right to erasure)

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exportCustomerData, anonymizeCustomer } from "@ibatexas/domain";
import { withLock } from "@ibatexas/tools";
import { requireAuth } from "../middleware/auth.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ErrorResponse = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

const CustomerDataResponse = z.object({
  customer: z.object({
    id: z.string(),
    phone: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    source: z.string().nullable(),
    firstContactAt: z.date().nullable(),
  }),
  addresses: z.array(z.object({
    id: z.string(),
    customerId: z.string(),
    street: z.string(),
    number: z.string(),
    complement: z.string().nullable(),
    district: z.string(),
    city: z.string(),
    state: z.string(),
    cep: z.string(),
    isDefault: z.boolean(),
  })),
  preferences: z.object({
    id: z.string(),
    customerId: z.string(),
    dietaryRestrictions: z.array(z.string()),
    allergenExclusions: z.array(z.string()),
    favoriteCategories: z.array(z.string()),
    updatedAt: z.date(),
  }).nullable(),
  reviews: z.array(z.object({
    id: z.string(),
    orderId: z.string(),
    productId: z.string().nullable(),
    customerId: z.string(),
    rating: z.number(),
    comment: z.string().nullable(),
    channel: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })),
  orderHistory: z.array(z.object({
    id: z.string(),
    customerId: z.string().nullable(),
    medusaOrderId: z.string(),
    productId: z.string(),
    variantId: z.string(),
    quantity: z.number(),
    priceInCentavos: z.number(),
    orderedAt: z.date(),
  })),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export async function meRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/me/data ────────────────────────────────────────────────────────

  app.get(
    "/api/me/data",
    {
      schema: {
        tags: ["me"],
        summary: "Exportar dados pessoais (LGPD Art. 18 — portabilidade)",
        response: { 200: CustomerDataResponse, 409: ErrorResponse },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      // Coordinate with erasure under one per-customer lock so an export can't
      // read a profile mid-erase.
      const data = await withLock(`lgpd:${customerId}`, () => exportCustomerData(customerId));
      if (!data) {
        return reply.status(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "Uma operação de privacidade está em andamento. Tente novamente em instantes.",
        });
      }
      return reply.send(data);
    },
  );

  // ── DELETE /api/me/data ─────────────────────────────────────────────────────

  const DeleteDataResponse = z.object({
    success: z.boolean(),
    message: z.string(),
  });

  app.delete(
    "/api/me/data",
    {
      schema: {
        tags: ["me"],
        summary: "Anonimizar dados pessoais (LGPD Art. 18 — eliminação)",
        response: { 200: DeleteDataResponse, 404: ErrorResponse },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      // One per-customer lock shared with export. Lock contention means a
      // concurrent erase is already running — idempotent, so report success.
      const result = await withLock(`lgpd:${customerId}`, () => anonymizeCustomer(customerId));
      if (result && !result.success) {
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Cliente não encontrado.",
        });
      }
      return reply.send({
        success: true,
        message: "Seus dados foram anonimizados conforme a LGPD.",
      });
    },
  );
}
