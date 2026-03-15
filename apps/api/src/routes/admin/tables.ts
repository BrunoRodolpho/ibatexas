import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "@ibatexas/domain";

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
        const tables = await prisma.table.findMany({ orderBy: { number: "asc" } })
        return reply.send({ tables })
      } catch (err) {
        reply.code(500).send({ error: "Failed to fetch tables" })
      }
    },
  )

  // POST /api/admin/tables
  app.post(
    "/api/admin/tables",
    {
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
        const table = await prisma.table.upsert({
          where: { number: body.number },
          update: {
            capacity: body.capacity,
            location: body.location,
            accessible: body.accessible,
            active: body.active,
          },
          create: body,
        })
        return reply.status(201).send({ table })
      } catch (err) {
        reply.code(500).send({ error: "Failed to upsert table" })
      }
    },
  )

  // POST /api/admin/timeslots — generate time slots for a date range
  app.post(
    "/api/admin/timeslots",
    {
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

        const from = new Date(`${body.fromDate}T00:00:00.000Z`)
        const to = new Date(`${body.toDate}T00:00:00.000Z`)
        const rows: { date: Date; startTime: string; maxCovers: number; durationMinutes: number }[] = []
        const current = new Date(from)

        while (current <= to) {
          for (const startTime of body.startTimes) {
            rows.push({
              date: new Date(current),
              startTime,
              maxCovers: body.maxCovers,
              durationMinutes: body.durationMinutes,
            })
          }
          current.setUTCDate(current.getUTCDate() + 1)
        }

        const result = await prisma.timeSlot.createMany({
          data: rows,
          skipDuplicates: true,
        })

        return reply.send({ created: result.count })
      } catch (err) {
        reply.code(500).send({ error: "Failed to generate time slots" })
      }
    },
  )
}
