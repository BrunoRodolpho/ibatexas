// Admin reservation routes.
//
// GET  /api/admin/reservations
// POST /api/admin/reservations/:id/checkin
// POST /api/admin/reservations/:id/complete
// POST /api/admin/reservations/:id/cancel
//
// ── Task 13/15 (M3) — kernel-gated transitions ──────────────────────────
//
// `checkin` and `complete` go through `transitionFromEnvelope` against
// `reservationsPolicyBundle` (staff-only by taint, ownership-checked by
// state). The envelope carries:
//   - actor.principal = "user" (staff JWT) | "system" (API key)
//   - taint            = "TRUSTED" | "SYSTEM"
//   - sessionId        = `admin:{staffId}` | `admin:api-key`
//
// The `cancel` admin endpoint remains a direct Prisma write — the
// reservation Pack's `cancel` policy is customer-focused (cancel-window
// guards), and admin-driven cancellation has different semantics (no
// time window). A follow-up task can introduce a dedicated
// `reservation.admin.cancel` intent kind if needed.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildEnvelope } from "@adjudicate/core";
import { createReservationService, prisma } from "@ibatexas/domain";
import type {
  ReservationCheckinPayload,
  ReservationCompletePayload,
  ReservationState,
} from "@ibatexas/pack-reservations";
import { getAuditSink } from "@ibatexas/llm-provider";
import type { ReservationDTO } from "@ibatexas/types";
import { requireManagerRole } from "../../middleware/staff-auth.js";

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

/** Build a minimal ReservationState snapshot for the admin transition path. */
async function snapshotReservationState(
  reservationId: string,
  staffId: string | null,
): Promise<ReservationState> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { timeSlot: true },
  });
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId,
      reservation: reservation
        ? {
            id: reservation.id,
            customerId: reservation.customerId,
            status: reservation.status,
            partySize: reservation.partySize,
          }
        : null,
    },
  } as ReservationState;
}

export async function reservationRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const svc = createReservationService({
    auditSink: getAuditSink(),
    log: server.log,
  });

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
      const staffId = request.staffId ?? null;
      const principal: "user" | "system" = staffId ? "user" : "system";
      const taint: "TRUSTED" | "SYSTEM" = staffId ? "TRUSTED" : "SYSTEM";
      const sessionId = staffId ? `admin:${staffId}` : "admin:api-key";

      const state = await snapshotReservationState(id, staffId);
      const payload: ReservationCheckinPayload = { reservationId: id };
      const envelope = buildEnvelope<
        "reservation.checkin",
        ReservationCheckinPayload
      >({
        kind: "reservation.checkin",
        payload,
        nonce: randomUUID(),
        actor: { principal, sessionId },
        taint,
      });

      const outcome = await svc.transitionFromEnvelope(envelope, state);
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        const refusalText =
          outcome.decision.kind === "REFUSE"
            ? outcome.decision.refusal.userFacing
            : "Operação não permitida pela política do kernel.";
        return reply.code(403).send({ error: refusalText });
      }
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
      const staffId = request.staffId ?? null;
      const principal: "user" | "system" = staffId ? "user" : "system";
      const taint: "TRUSTED" | "SYSTEM" = staffId ? "TRUSTED" : "SYSTEM";
      const sessionId = staffId ? `admin:${staffId}` : "admin:api-key";

      const state = await snapshotReservationState(id, staffId);
      const payload: ReservationCompletePayload = { reservationId: id };
      const envelope = buildEnvelope<
        "reservation.complete",
        ReservationCompletePayload
      >({
        kind: "reservation.complete",
        payload,
        nonce: randomUUID(),
        actor: { principal, sessionId },
        taint,
      });

      const outcome = await svc.transitionFromEnvelope(envelope, state);
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        const refusalText =
          outcome.decision.kind === "REFUSE"
            ? outcome.decision.refusal.userFacing
            : "Operação não permitida pela política do kernel.";
        return reply.code(403).send({ error: refusalText });
      }
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

      await prisma.$transaction([
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

      return reply.send({ success: true });
    },
  );
}
