import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createReservationService, prisma } from "@ibatexas/domain";
import type { ReservationDTO } from "@ibatexas/types";
import type {
  ReservationCancelPayload,
  ReservationCheckinPayload,
  ReservationCompletePayload,
} from "@ibatexas/pack-reservations";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import {
  adjudicateStaffMutation,
  replyForIntent,
} from "../__shared__/customer-intent-gateway.js";

/** Map a ReservationDTO + customer data into the admin-friendly shape the UI expects. */
function toAdminReservation(
  dto: ReservationDTO,
  customer: { name: string | null; phone: string } | undefined,
  tableNumbers: string[],
) {
  const dateTime =
    dto.timeSlot.date && dto.timeSlot.startTime
      ? `${dto.timeSlot.date}T${dto.timeSlot.startTime}:00`
      : null;

  return {
    ...dto,
    customerName: customer?.name ?? null,
    customerPhone: customer?.phone ?? null,
    dateTime,
    tableNumber: tableNumbers.length > 0 ? tableNumbers.join(', ') : null,
  };
}

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
        date?: string;
        status?: string;
        limit: number;
        offset: number;
      };

      const result = await svc.listAll({ date, status }, { limit, offset });

      const reservationIds = result.reservations.map((r) => r.id);

      // Batch-fetch customer data and table assignments for all reservations
      const customerIds = [...new Set(result.reservations.map((r) => r.customerId))];
      const [customers, tableAssignments] = await Promise.all([
        customerIds.length > 0
          ? prisma.customer.findMany({
              where: { id: { in: customerIds } },
              select: { id: true, name: true, phone: true },
            })
          : [],
        reservationIds.length > 0
          ? prisma.reservationTable.findMany({
              where: { reservationId: { in: reservationIds } },
              include: { table: { select: { number: true } } },
            })
          : [],
      ]);

      const customerMap = new Map(customers.map((c) => [c.id, c]));
      const tablesByReservation = new Map<string, string[]>();
      for (const ta of tableAssignments) {
        const list = tablesByReservation.get(ta.reservationId) ?? [];
        list.push(ta.table.number);
        tablesByReservation.set(ta.reservationId, list);
      }

      const reservations = result.reservations.map((r) =>
        toAdminReservation(r, customerMap.get(r.customerId), tablesByReservation.get(r.id) ?? []),
      );

      return reply.send({ reservations, total: result.total });
    },
  );

  // POST /api/admin/reservations/:id/checkin
  app.post(
    "/api/admin/reservations/:id/checkin",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Check-in do hóspede (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // RC-A1 Phase B — checkin is a STAFF-ONLY pack kind (requireStaff needs
      // staffId !== null). Carry staffId into the state so the guard passes; the
      // route's requireManagerRole preHandler already authenticated the staff member.
      // The reservation snapshot satisfies requireReservationPresent. The findUnique
      // is OUTSIDE the legacy closure (state assembly only) so the inert path stays
      // byte-equivalent — svc.transition still runs unconditionally and handles a
      // missing row exactly as before.
      const r = await prisma.reservation.findUnique({ where: { id } });
      const outcome = await adjudicateStaffMutation({
        kind: "reservation.checkin",
        payload: { reservationId: id } satisfies ReservationCheckinPayload,
        staffId: request.staffId ?? "staff",
        state: {
          ctx: {
            channel: "staff",
            customerId: r?.customerId ?? null,
            staffId: request.staffId ?? null,
            reservation: r
              ? { id: r.id, status: r.status as never, partySize: r.partySize, timeSlotId: r.timeSlotId }
              : null,
          },
        },
        legacy: () => svc.transition(id, "seated"),
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.send({ success: true });
    },
  );

  // POST /api/admin/reservations/:id/complete
  app.post(
    "/api/admin/reservations/:id/complete",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Marcar reserva como concluída (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // RC-A1 Phase B — complete is a STAFF-ONLY pack kind. Same shape as checkin:
      // staffId into state for requireStaff; reservation snapshot for
      // requireReservationPresent; findUnique outside the legacy closure so inert
      // stays byte-equivalent.
      const r = await prisma.reservation.findUnique({ where: { id } });
      const outcome = await adjudicateStaffMutation({
        kind: "reservation.complete",
        payload: { reservationId: id } satisfies ReservationCompletePayload,
        staffId: request.staffId ?? "staff",
        state: {
          ctx: {
            channel: "staff",
            customerId: r?.customerId ?? null,
            staffId: request.staffId ?? null,
            reservation: r
              ? { id: r.id, status: r.status as never, partySize: r.partySize, timeSlotId: r.timeSlotId }
              : null,
          },
        },
        legacy: () => svc.transition(id, "completed"),
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);
      return reply.send({ success: true });
    },
  );

  // POST /api/admin/reservations/:id/cancel
  app.post(
    "/api/admin/reservations/:id/cancel",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Cancelar reserva (admin)",
        params: z.object({ id: z.string() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const reservation = await prisma.reservation.findUnique({
        where: { id },
        include: { timeSlot: true },
      });

      if (!reservation) {
        return reply.code(404).send({ error: "Reserva não encontrada." });
      }

      if (["cancelled", "completed", "no_show"].includes(reservation.status)) {
        return reply.code(422).send({ error: "Reserva não pode ser cancelada neste status." });
      }

      // RC-A1 Phase B — gate the admin reservation cancel through the staff conductor.
      // D-B: reservation.cancel is a CUSTOMER-facing kind (the pack's requireAuthenticated
      // guard needs a customerId). Rather than relax that tested guard, we carry the
      // reservation OWNER's customerId into the adjudication state so it passes on the
      // REAL owner's identity; requireManagerRole (route preHandler) enforces staff
      // authority. The pack invariant is kept intact. now/slot are intentionally omitted
      // so confirmLastMinuteCancel stays dormant — an admin override is not subject to the
      // customer last-minute-cancel prompt, which keeps post-flip behaviour byte-equivalent
      // to the legacy direct cancel. (Owner customerId is assumed present — reservations are
      // always created by a customer; a null owner would REFUSE post-flip, surfacing as a
      // visible failure rather than a silent ungated mutation.)
      const doCancel = () =>
        prisma.$transaction([
          prisma.reservation.update({
            where: { id },
            data: { status: "cancelled", cancelledAt: new Date() },
          }),
          prisma.reservationTable.deleteMany({ where: { reservationId: id } }),
          prisma.timeSlot.update({
            where: { id: reservation.timeSlotId },
            data: { reservedCovers: { decrement: reservation.partySize } },
          }),
        ]);

      const outcome = await adjudicateStaffMutation({
        kind: "reservation.cancel",
        payload: { reservationId: id } satisfies ReservationCancelPayload,
        staffId: request.staffId ?? "staff",
        state: {
          ctx: {
            channel: "staff",
            customerId: reservation.customerId,
            staffId: request.staffId ?? null,
            reservation: {
              id: reservation.id,
              status: reservation.status,
              partySize: reservation.partySize,
              timeSlotId: reservation.timeSlotId,
            },
          },
        },
        legacy: doCancel,
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      return reply.send({ success: true });
    },
  );
}
