// Admin delivery zone CRUD
//
// GET    /api/admin/delivery-zones        — list all zones
// POST   /api/admin/delivery-zones        — create zone
// PUT    /api/admin/delivery-zones/:id    — update zone
// DELETE /api/admin/delivery-zones/:id   — delete zone

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createDeliveryZoneService } from "@ibatexas/domain";
import { getRedisClient, invalidateDeliveryCache, rk } from "@ibatexas/tools";
import { requireManagerRole } from "../../middleware/staff-auth.js";

const DeliveryZoneIdParams = z.object({ id: z.string().min(1) });

const CepEntry = z.string().regex(/^\d{5}(\d{3})?$/, "CEP deve ter 5 dígitos (prefixo) ou 8 dígitos (completo)");

const DeliveryZoneBody = z.object({
  name: z.string().min(1).max(100),
  cepPrefixes: z.array(CepEntry).min(1, "Informe ao menos um CEP"),
  feeInCentavos: z.number().int().min(0),
  estimatedMinutes: z.number().int().min(1).max(180),
  active: z.boolean().optional().default(true),
});

type DeliveryZoneService = ReturnType<typeof createDeliveryZoneService>;

// Idempotency guard shared by the mutating zone routes (create/update/delete).
// Returns true when a duplicate request was detected and a 409 was already sent.
async function rejectIfDuplicateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
): Promise<boolean> {
  const requestId = request.headers["x-request-id"] as string | undefined;
  if (!requestId) return false;
  const redis = await getRedisClient();
  const isNew = await redis.set(rk(`dz:${action}:dedup:${requestId}`), "1", { EX: 300, NX: true });
  if (!isNew) {
    reply.code(409).send({ error: "Requisicao duplicada." });
    return true;
  }
  return false;
}

// Reject CEP prefixes already assigned to another zone. Pass excludeZoneId on
// update to skip the zone being edited. Returns true when a conflict was
// detected and a 422 was already sent.
async function rejectOnCepConflict(
  deliveryZoneSvc: DeliveryZoneService,
  reply: FastifyReply,
  cepPrefixes: string[],
  excludeZoneId?: string,
): Promise<boolean> {
  const existing = await deliveryZoneSvc.listAll();
  const allUsedCeps = new Map<string, string>();
  for (const z of existing) {
    if (excludeZoneId !== undefined && z.id === excludeZoneId) continue;
    for (const c of z.cepPrefixes) allUsedCeps.set(c, z.name);
  }
  const dupes = cepPrefixes.filter((c) => allUsedCeps.has(c));
  if (dupes.length === 0) return false;
  const dupeList = dupes.map((c) => `${c} (${allUsedCeps.get(c)})`).join(", ");
  reply.code(422).send({
    error: "CEPs já atribuídos",
    message: `CEPs já usados em outras zonas: ${dupeList}`,
  });
  return true;
}

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
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Criar zona de entrega (admin)",
        body: DeliveryZoneBody,
      },
    },
    async (request, reply) => {
      if (await rejectIfDuplicateRequest(request, reply, "create")) return reply;
      const deliveryZoneSvc = createDeliveryZoneService();
      // Check for duplicate CEPs across existing zones
      if (await rejectOnCepConflict(deliveryZoneSvc, reply, request.body.cepPrefixes)) return reply;
      const zone = await deliveryZoneSvc.create(request.body);
      void invalidateDeliveryCache();
      return reply.code(201).send({ zone });
    },
  );

  // PUT /api/admin/delivery-zones/:id
  app.put(
    "/api/admin/delivery-zones/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Atualizar zona de entrega (admin)",
        params: DeliveryZoneIdParams,
        body: DeliveryZoneBody,
      },
    },
    async (request, reply) => {
      if (await rejectIfDuplicateRequest(request, reply, "update")) return reply;
      const deliveryZoneSvc = createDeliveryZoneService();
      // Check for duplicate CEPs across OTHER zones (exclude the one being updated)
      if (await rejectOnCepConflict(deliveryZoneSvc, reply, request.body.cepPrefixes, request.params.id))
        return reply;
      const zone = await deliveryZoneSvc.update(request.params.id, request.body);
      void invalidateDeliveryCache();
      return reply.send({ zone });
    },
  );

  // DELETE /api/admin/delivery-zones/:id
  app.delete(
    "/api/admin/delivery-zones/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Remover zona de entrega (admin)",
        params: DeliveryZoneIdParams,
      },
    },
    async (request, reply) => {
      if (await rejectIfDuplicateRequest(request, reply, "delete")) return reply;
      const deliveryZoneSvc = createDeliveryZoneService();
      await deliveryZoneSvc.remove(request.params.id);
      void invalidateDeliveryCache();
      return reply.send({ ok: true });
    },
  );
}
