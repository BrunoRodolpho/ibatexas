import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createTableService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";

export async function tableRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // GET /api/admin/tables
  app.get(
    "/api/admin/tables",
    {
      schema: { tags: ["admin"], summary: "Listar mesas (admin)" },
    },
    async (_request, reply) => {
      try {
        const tableSvc = createTableService()
        const tables = await tableSvc.listAll()
        return reply.send({ tables })
      } catch (err) {
        server.log.error(err, "Failed to fetch tables");
        reply.code(500).send({ error: "Failed to fetch tables" })
      }
    },
  )

  // POST /api/admin/tables
  app.post(
    "/api/admin/tables",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Criar ou atualizar mesa (admin)",
        body: z.object({
          number: z.string(),
          capacity: z.number().int().min(1),
          location: z.enum(["indoor", "outdoor", "bar", "terrace"]),
          accessible: z.boolean().optional().default(false),
          active: z.boolean().optional().default(true),
        }),
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as {
          number: string
          capacity: number
          location: "indoor" | "outdoor" | "bar" | "terrace"
          accessible: boolean
          active: boolean
        }
        const tableSvc = createTableService()
        const table = await tableSvc.upsert(body)
        return reply.status(201).send({ table })
      } catch (err) {
        server.log.error(err, "Failed to upsert table");
        reply.code(500).send({ error: "Failed to upsert table" })
      }
    },
  )

  // POST /api/admin/timeslots — generate time slots for a date range
  app.post(
    "/api/admin/timeslots",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Gerar horários para um intervalo de datas (admin)",
        body: z.object({
          fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          startTimes: z.array(z.string()).min(1),
          maxCovers: z.number().int().min(1),
          durationMinutes: z.number().int().min(30).optional().default(90),
        }),
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as {
          fromDate: string
          toDate: string
          startTimes: string[]
          maxCovers: number
          durationMinutes: number
        }

        const tableSvc = createTableService()
        const result = await tableSvc.generateTimeSlots(body)

        return reply.send({ created: result.count })
      } catch (err) {
        server.log.error(err, "Failed to generate time slots");
        reply.code(500).send({ error: "Failed to generate time slots" })
      }
    },
  )
}
