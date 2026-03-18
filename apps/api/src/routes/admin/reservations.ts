import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createReservationService } from "@ibatexas/domain";

export async function reservationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const svc = createReservationService();

  // GET /api/admin/reservations
  app.get(
    "/api/admin/reservations",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar todas as reservas (admin)",
        querystring: z.object({
          date: z.string().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional().default(50),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { date, status, limit, offset } = request.query as {
        date?: string
        status?: string
        limit: number
        offset: number
      }

      const result = await svc.listAll({ date, status }, { limit, offset })
      return reply.send(result)
    },
  )

  // POST /api/admin/reservations/:id/checkin
  app.post(
    "/api/admin/reservations/:id/checkin",
    {
      schema: {
        tags: ["admin"],
        summary: "Check-in do hóspede (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      await svc.transition(id, "seated")
      return reply.send({ success: true })
    },
  )

  // POST /api/admin/reservations/:id/complete
  app.post(
    "/api/admin/reservations/:id/complete",
    {
      schema: {
        tags: ["admin"],
        summary: "Marcar reserva como concluída (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      await svc.transition(id, "completed")
      return reply.send({ success: true })
    },
  )
}
