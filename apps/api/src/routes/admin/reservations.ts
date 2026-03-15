import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "@ibatexas/domain";

export async function reservationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

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
      try {
        const { date, status, limit, offset } = request.query as {
          date?: string
          status?: string
          limit: number
          offset: number
        }

        const where: Record<string, unknown> = {}
        if (status) where.status = status
        if (date) where.timeSlot = { date: new Date(`${date}T00:00:00.000Z`) }

        const [reservations, total] = await Promise.all([
          prisma.reservation.findMany({
            where,
            include: { timeSlot: true, tables: { include: { table: true } } },
            orderBy: [{ timeSlot: { date: "asc" } }, { timeSlot: { startTime: "asc" } }],
            take: limit,
            skip: offset,
          }),
          prisma.reservation.count({ where }),
        ])

        return reply.send({ reservations, total })
      } catch (err) {
        reply.code(500).send({ error: "Failed to fetch reservations" })
      }
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
      try {
        const { id } = request.params as { id: string }
        const updated = await prisma.reservation.update({
          where: { id },
          data: { status: "seated", checkedInAt: new Date() },
        })
        return reply.send({ reservation: updated })
      } catch (err) {
        reply.code(500).send({ error: "Failed to check in reservation" })
      }
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
      try {
        const { id } = request.params as { id: string }
        const updated = await prisma.reservation.update({
          where: { id },
          data: { status: "completed" },
        })
        return reply.send({ reservation: updated })
      } catch (err) {
        reply.code(500).send({ error: "Failed to complete reservation" })
      }
    },
  )
}
