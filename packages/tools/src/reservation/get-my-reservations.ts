// get_my_reservations tool
// Lists the authenticated customer's reservations.
// Auth: customer

import { prisma } from "@ibatexas/domain"
import { GetMyReservationsInputSchema, type GetMyReservationsInput, type GetMyReservationsOutput } from "@ibatexas/types"
import { reservationToDTO, type ReservationWithRelations } from "./utils.js"

export async function getMyReservations(
  input: GetMyReservationsInput,
): Promise<GetMyReservationsOutput> {
  const parsed = GetMyReservationsInputSchema.parse(input)

  const where = {
    customerId: parsed.customerId,
    ...(parsed.status ? { status: parsed.status } : {}),
  }

  const [reservations, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      include: { timeSlot: true, tables: { include: { table: true } } },
      orderBy: [{ timeSlot: { date: "desc" } }, { timeSlot: { startTime: "desc" } }],
      take: parsed.limit,
    }),
    prisma.reservation.count({ where }),
  ])

  return {
    reservations: (reservations as unknown as ReservationWithRelations[]).map(reservationToDTO),
    total,
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const GetMyReservationsTool = {
  name: "get_my_reservations",
  description:
    "Lista as reservas do cliente autenticado (próximas e passadas). Pode filtrar por status.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "ID do cliente" },
      status: {
        type: "string",
        enum: ["pending", "confirmed", "seated", "completed", "cancelled", "no_show"],
        description: "Filtrar por status (opcional)",
      },
      limit: {
        type: "number",
        description: "Máximo de resultados (padrão: 10)",
      },
    },
    required: ["customerId"],
  },
}
