// Admin table + reservation time-slot management (OPS-018 + OPS-019).
//
// GET    /api/admin/tables        — list all tables
// POST   /api/admin/tables        — create a table (409 on duplicate number)
// PATCH  /api/admin/tables/:id    — partially update a table
// DELETE /api/admin/tables/:id    — soft-deactivate a table (active = false)
// POST   /api/admin/timeslots     — generate reservation time slots for a range
//
// All mutations are manager-gated (requireManagerRole). These are staff ops
// with no LLM/agent caller — see the DEFERRED_ADMIN_LOW_RISK rationale in
// apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts.

import type { FastifyInstance } from "fastify"
import { ZodTypeProvider } from "fastify-type-provider-zod"
import { z } from "zod"
import {
  createTableService,
  DuplicateTableNumberError,
  TableNotFoundError,
  TableHasFutureReservationsError,
} from "@ibatexas/domain"
import { requireManagerRole } from "../../middleware/staff-auth.js"

const TableLocationEnum = z.enum(["indoor", "outdoor", "bar", "terrace"])
const TableIdParams = z.object({ id: z.string().min(1) })

const TABLE_HAS_RESERVATIONS_MSG =
  "Mesa tem reservas futuras — cancele ou realoque antes de desativar."

const CreateTableBody = z.object({
  number: z.string().min(1),
  capacity: z.number().int().min(1),
  location: TableLocationEnum,
  accessible: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
})

const UpdateTableBody = z
  .object({
    number: z.string().min(1).optional(),
    capacity: z.number().int().min(1).optional(),
    location: TableLocationEnum.optional(),
    accessible: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Informe ao menos um campo para atualizar.",
  })

const GenerateTimeSlotsBody = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate deve ser AAAA-MM-DD").optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "toDate deve ser AAAA-MM-DD").optional(),
  startTimes: z
    .array(z.string().regex(/^\d{2}:\d{2}$/, "Horário deve ser HH:MM"))
    .optional(),
  intervalMinutes: z.number().int().min(5).max(240).optional(),
  maxCovers: z.number().int().min(1),
  durationMinutes: z.number().int().min(30).max(600).optional(),
})

export async function tableRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>()

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
        server.log.error(err, "Failed to fetch tables")
        return reply.code(500).send({ error: "Falha ao listar as mesas." })
      }
    },
  )

  // POST /api/admin/tables — create
  app.post(
    "/api/admin/tables",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Criar mesa (admin)",
        body: CreateTableBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateTableBody>
      try {
        const tableSvc = createTableService()
        const table = await tableSvc.create(body)
        return reply.status(201).send({ table })
      } catch (err) {
        if (err instanceof DuplicateTableNumberError) {
          return reply
            .code(409)
            .send({ error: `Já existe uma mesa com o número "${err.number}".` })
        }
        server.log.error(err, "Failed to create table")
        return reply.code(500).send({ error: "Falha ao criar a mesa." })
      }
    },
  )

  // PATCH /api/admin/tables/:id — partial update
  app.patch(
    "/api/admin/tables/:id",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Atualizar mesa (admin)",
        params: TableIdParams,
        body: UpdateTableBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof TableIdParams>
      const patch = request.body as z.infer<typeof UpdateTableBody>
      try {
        const tableSvc = createTableService()
        const table = await tableSvc.update(id, patch)
        return reply.send({ table })
      } catch (err) {
        if (err instanceof TableNotFoundError) {
          return reply.code(404).send({ error: "Mesa não encontrada." })
        }
        if (err instanceof TableHasFutureReservationsError) {
          return reply.code(409).send({ error: TABLE_HAS_RESERVATIONS_MSG })
        }
        if (err instanceof DuplicateTableNumberError) {
          return reply
            .code(409)
            .send({ error: `Já existe uma mesa com o número "${err.number}".` })
        }
        server.log.error(err, "Failed to update table")
        return reply.code(500).send({ error: "Falha ao atualizar a mesa." })
      }
    },
  )

  // DELETE /api/admin/tables/:id — soft-deactivate (active = false)
  app.delete(
    "/api/admin/tables/:id",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Desativar mesa (admin)",
        params: TableIdParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof TableIdParams>
      try {
        const tableSvc = createTableService()
        const table = await tableSvc.update(id, { active: false })
        return reply.send({ table })
      } catch (err) {
        if (err instanceof TableNotFoundError) {
          return reply.code(404).send({ error: "Mesa não encontrada." })
        }
        if (err instanceof TableHasFutureReservationsError) {
          return reply.code(409).send({ error: TABLE_HAS_RESERVATIONS_MSG })
        }
        server.log.error(err, "Failed to deactivate table")
        return reply.code(500).send({ error: "Falha ao desativar a mesa." })
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
        summary: "Gerar horários de reserva para um intervalo de datas (admin)",
        body: GenerateTimeSlotsBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof GenerateTimeSlotsBody>
      try {
        const tableSvc = createTableService()
        const result = await tableSvc.generateTimeSlots(body)
        return reply.send({ created: result.count })
      } catch (err) {
        if (err instanceof RangeError) {
          return reply.code(400).send({ error: "Intervalo de datas ou horário inválido." })
        }
        server.log.error(err, "Failed to generate time slots")
        return reply.code(500).send({ error: "Falha ao gerar os horários." })
      }
    },
  )
}
