// Admin delivery zone CRUD
//
// GET    /api/admin/delivery-zones        — list all zones
// POST   /api/admin/delivery-zones        — create zone
// PUT    /api/admin/delivery-zones/:id    — update zone
// DELETE /api/admin/delivery-zones/:id   — delete zone

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createDeliveryZoneService } from "@ibatexas/domain";

const DeliveryZoneIdParams = z.object({ id: z.string().min(1) });

const DeliveryZoneBody = z.object({
  name: z.string().min(1).max(100),
  cepPrefixes: z.array(z.string().regex(/^\d{5}$/, "CEP prefix deve ter 5 dígitos")),
  feeInCentavos: z.number().int().min(0),
  estimatedMinutes: z.number().int().min(1).max(180),
  active: z.boolean().optional().default(true),
});

export async function deliveryZoneRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // GET /api/admin/delivery-zones
  app.get(
    "/api/admin/delivery-zones",
    {
      schema: { tags: ["admin"], summary: "Listar zonas de entrega (admin)" },
    },
    async (_request, reply) => {
      const deliveryZoneSvc = createDeliveryZoneService();
      const zones = await deliveryZoneSvc.listAll();
      return reply.send({ zones });
    },
  );

  // POST /api/admin/delivery-zones
  app.post(
    "/api/admin/delivery-zones",
    {
      schema: {
        tags: ["admin"],
        summary: "Criar zona de entrega (admin)",
        body: DeliveryZoneBody,
      },
    },
    async (request, reply) => {
      const deliveryZoneSvc = createDeliveryZoneService();
      const zone = await deliveryZoneSvc.create(request.body);
      return reply.code(201).send({ zone });
    },
  );

  // PUT /api/admin/delivery-zones/:id
  app.put(
    "/api/admin/delivery-zones/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Atualizar zona de entrega (admin)",
        params: DeliveryZoneIdParams,
        body: DeliveryZoneBody,
      },
    },
    async (request, reply) => {
      const deliveryZoneSvc = createDeliveryZoneService();
      const zone = await deliveryZoneSvc.update(request.params.id, request.body);
      return reply.send({ zone });
    },
  );

  // DELETE /api/admin/delivery-zones/:id
  app.delete(
    "/api/admin/delivery-zones/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Remover zona de entrega (admin)",
        params: DeliveryZoneIdParams,
      },
    },
    async (request, reply) => {
      const deliveryZoneSvc = createDeliveryZoneService();
      await deliveryZoneSvc.remove(request.params.id);
      return reply.send({ ok: true });
    },
  );
}
