// Reservation routes
//
// GET  /api/reservations/availability  — check available time slots (guest)
// POST /api/reservations               — create reservation (customer)
// GET  /api/reservations               — list my reservations (customer)
// PATCH /api/reservations/:id          — modify reservation (customer)
// DELETE /api/reservations/:id         — cancel reservation (customer)
// POST /api/reservations/:id/waitlist  — join waitlist (customer)

import type { FastifyInstance } from "fastify"
import { ZodTypeProvider } from "fastify-type-provider-zod"
import { z } from "zod"
import {
  checkTableAvailability,
  createReservation,
  modifyReservation,
  cancelReservation,
  getMyReservations,
  joinWaitlist,
} from "@ibatexas/tools"
import { SpecialRequestSchema, ReservationStatus } from "@ibatexas/types"

// ── Zod schemas ───────────────────────────────────────────────────────────────

const AvailabilityQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida — use YYYY-MM-DD"),
  partySize: z.coerce.number().int().min(1).max(20),
  preferredTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
})

const ReservationIdParams = z.object({
  id: z.string().min(1),
})

const CreateReservationBody = z.object({
  // TODO: Step 11 — customerId will come from JWT; accepted in body for now
  customerId: z.string().min(1),
  timeSlotId: z.string().min(1),
  partySize: z.number().int().min(1).max(20),
  specialRequests: z.array(SpecialRequestSchema).optional().default([]),
})

const ModifyReservationBody = z.object({
  // TODO: Step 11 — customerId will come from JWT; accepted in body for now
  customerId: z.string().min(1),
  newTimeSlotId: z.string().optional(),
  newPartySize: z.number().int().min(1).max(20).optional(),
  specialRequests: z.array(SpecialRequestSchema).optional(),
})

const CancelReservationBody = z.object({
  customerId: z.string().min(1),
  reason: z.string().max(200).optional(),
})

const MyReservationsQuery = z.object({
  customerId: z.string().min(1),
  status: z.nativeEnum(ReservationStatus).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

const JoinWaitlistBody = z.object({
  customerId: z.string().min(1),
  partySize: z.number().int().min(1).max(20),
})

// ── Routes ────────────────────────────────────────────────────────────────────

export async function reservationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>()

  // GET /api/reservations/availability
  app.get(
    "/api/reservations/availability",
    {
      schema: {
        tags: ["reservations"],
        summary: "Verificar disponibilidade de mesas",
        querystring: AvailabilityQuery,
      },
    },
    async (request, reply) => {
      const result = await checkTableAvailability(request.query)
      return reply.send(result)
    },
  )

  // POST /api/reservations — create
  app.post(
    "/api/reservations",
    {
      schema: {
        tags: ["reservations"],
        summary: "Criar reserva",
        body: CreateReservationBody,
      },
    },
    async (request, reply) => {
      const result = await createReservation(request.body)
      return reply.status(201).send(result)
    },
  )

  // GET /api/reservations — list mine
  app.get(
    "/api/reservations",
    {
      schema: {
        tags: ["reservations"],
        summary: "Listar minhas reservas",
        querystring: MyReservationsQuery,
      },
    },
    async (request, reply) => {
      const result = await getMyReservations(request.query)
      return reply.send(result)
    },
  )

  // PATCH /api/reservations/:id — modify
  app.patch(
    "/api/reservations/:id",
    {
      schema: {
        tags: ["reservations"],
        summary: "Modificar reserva",
        params: ReservationIdParams,
        body: ModifyReservationBody,
      },
    },
    async (request, reply) => {
      const result = await modifyReservation({
        ...request.body,
        reservationId: request.params.id,
      })
      if (!result.success) {
        return reply.status(400).send({ statusCode: 400, message: result.message })
      }
      return reply.send(result)
    },
  )

  // DELETE /api/reservations/:id — cancel
  app.delete(
    "/api/reservations/:id",
    {
      schema: {
        tags: ["reservations"],
        summary: "Cancelar reserva",
        params: ReservationIdParams,
        body: CancelReservationBody,
      },
    },
    async (request, reply) => {
      const result = await cancelReservation({
        ...request.body,
        reservationId: request.params.id,
      })
      if (!result.success) {
        return reply.status(400).send({ statusCode: 400, message: result.message })
      }
      return reply.send(result)
    },
  )

  // POST /api/reservations/:id/waitlist — join waitlist
  app.post(
    "/api/reservations/:id/waitlist",
    {
      schema: {
        tags: ["reservations"],
        summary: "Entrar na lista de espera",
        params: ReservationIdParams,
        body: JoinWaitlistBody,
      },
    },
    async (request, reply) => {
      const result = await joinWaitlist({
        ...request.body,
        timeSlotId: request.params.id,
      })
      return reply.status(201).send(result)
    },
  )
}
