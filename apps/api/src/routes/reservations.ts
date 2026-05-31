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
import { requireAuth } from "../middleware/auth.js"
import {
  adjudicateCustomerMutation,
  replyForIntent,
} from "./__shared__/customer-intent-gateway.js"

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
  timeSlotId: z.string().min(1),
  partySize: z.number().int().min(1).max(20),
  specialRequests: z.array(SpecialRequestSchema).optional().default([]),
})

const ModifyReservationBody = z.object({
  newTimeSlotId: z.string().optional(),
  newPartySize: z.number().int().min(1).max(20).optional(),
  specialRequests: z.array(SpecialRequestSchema).optional(),
})

const CancelReservationBody = z.object({
  reason: z.string().max(200).optional(),
})

const MyReservationsQuery = z.object({
  status: z.nativeEnum(ReservationStatus).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

const JoinWaitlistBody = z.object({
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
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!
      // RC-A1 Phase B — gate the create through the conductor when active;
      // byte-equivalent legacy path while inert. The whole createReservation
      // mutation is the adjudicated side effect; the requireAuth pre-check and
      // Zod body validation stay outside the wrapper. Moved verbatim.
      const outcome = await adjudicateCustomerMutation({
        kind: "reservation.create",
        // ReservationCreatePayload: { timeSlotId, partySize, specialRequests? }.
        payload: {
          timeSlotId: request.body.timeSlotId,
          partySize: request.body.partySize,
          specialRequests: request.body.specialRequests,
        },
        customerId,
        // ReservationState the reservations PolicyBundle inspects for
        // reservation.create: requireAuthenticated (customerId non-null) +
        // requireSlotWithCapacity / requireSlotInFuture (slot snapshot) +
        // validatePartySize + escalateHighNoShowRate / refuseBlockedCustomer
        // (customer snapshot). GAP: the thin HTTP handler has neither the slot
        // capacity/startAt snapshot nor the customer no-show/blocked snapshot —
        // those live in reservation.service.ts under a FOR UPDATE lock. Set to
        // null here; full state-correctness is validated at the witnessed flip.
        // IGNORED while inert (legacy runs).
        state: {
          ctx: {
            channel: "web",
            customerId,
            staffId: null,
            now: null,
            slot: null,
            customer: null,
          },
        },
        legacy: async () => createReservation({ ...request.body, customerId }),
      })
      if (!outcome.ran) return replyForIntent(reply, outcome.intent)
      return reply.status(201).send(outcome.result)
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
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!
      const result = await getMyReservations({ ...request.query, customerId })
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
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!
      // RC-A1 Phase B — gate the modify through the conductor when active;
      // byte-equivalent legacy path while inert. requireAuth + Zod validation
      // stay outside; the modifyReservation call is moved verbatim into legacy.
      const outcome = await adjudicateCustomerMutation({
        kind: "reservation.modify",
        // ReservationModifyPayload: { reservationId, newTimeSlotId?,
        // newPartySize?, specialRequests? }.
        payload: {
          reservationId: request.params.id,
          newTimeSlotId: request.body.newTimeSlotId,
          newPartySize: request.body.newPartySize,
          specialRequests: request.body.specialRequests,
        },
        customerId,
        // ReservationState for reservation.modify: requireReservationPresent /
        // requireReservationModifiable (existing-reservation snapshot),
        // refuseModifyOnFullNewSlot (newSlot snapshot), validatePartySize.
        // GAP: the thin handler holds neither the existing-reservation snapshot
        // nor the target-slot capacity snapshot (both fetched under lock inside
        // reservation.service.ts) — set null. IGNORED while inert (legacy runs).
        state: {
          ctx: {
            channel: "web",
            customerId,
            staffId: null,
            now: null,
            reservation: null,
            newSlot: null,
          },
        },
        legacy: async () =>
          modifyReservation({
            ...request.body,
            customerId,
            reservationId: request.params.id,
          }),
      })
      if (!outcome.ran) return replyForIntent(reply, outcome.intent)
      const result = outcome.result
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
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!
      // RC-A1 Phase B — gate the cancel through the conductor when active;
      // byte-equivalent legacy path while inert. requireAuth + Zod validation
      // stay outside; the cancelReservation call is moved verbatim into legacy.
      const outcome = await adjudicateCustomerMutation({
        kind: "reservation.cancel",
        // ReservationCancelPayload: { reservationId, reason? }.
        payload: {
          reservationId: request.params.id,
          reason: request.body.reason,
        },
        customerId,
        // ReservationState for reservation.cancel: requireReservationPresent /
        // requireReservationCancellable (existing-reservation snapshot),
        // confirmLastMinuteCancel (slot.startAt + now → REQUEST_CONFIRMATION).
        // GAP: the thin handler has neither the existing-reservation snapshot
        // nor the slot start time (both inside reservation.service.ts) — set
        // null; `now` left null too. IGNORED while inert (legacy runs).
        state: {
          ctx: {
            channel: "web",
            customerId,
            staffId: null,
            now: null,
            slot: null,
            reservation: null,
          },
        },
        legacy: async () =>
          cancelReservation({
            ...request.body,
            customerId,
            reservationId: request.params.id,
          }),
      })
      if (!outcome.ran) return replyForIntent(reply, outcome.intent)
      const result = outcome.result
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
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!
      // RC-A1 Phase B — gate the waitlist-join through the conductor when
      // active; byte-equivalent legacy path while inert. requireAuth + Zod
      // validation stay outside; the joinWaitlist call is moved verbatim.
      const outcome = await adjudicateCustomerMutation({
        kind: "reservation.waitlist.join",
        // ReservationWaitlistJoinPayload: { timeSlotId, partySize }.
        payload: {
          timeSlotId: request.params.id,
          partySize: request.body.partySize,
        },
        customerId,
        // ReservationState for reservation.waitlist.join: requireAuthenticated
        // (customerId non-null) + validatePartySize (payload only). No slot /
        // reservation snapshot is consulted by any guard for this kind, so the
        // snapshot fields are simply absent. IGNORED while inert (legacy runs).
        state: {
          ctx: {
            channel: "web",
            customerId,
            staffId: null,
          },
        },
        legacy: async () =>
          joinWaitlist({
            ...request.body,
            customerId,
            timeSlotId: request.params.id,
          }),
      })
      if (!outcome.ran) return replyForIntent(reply, outcome.intent)
      return reply.status(201).send(outcome.result)
    },
  )
}
