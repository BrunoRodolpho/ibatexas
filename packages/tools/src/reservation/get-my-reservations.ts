// get_my_reservations tool
// Lists the authenticated customer's reservations.
// Auth: customer

import { createReservationService } from "@ibatexas/domain"
import { GetMyReservationsInputSchema, type GetMyReservationsInput, type GetMyReservationsOutput } from "@ibatexas/types"

export async function getMyReservations(
  input: GetMyReservationsInput,
): Promise<GetMyReservationsOutput> {
  const parsed = GetMyReservationsInputSchema.parse(input)

  const svc = createReservationService()
  return svc.listByCustomer(parsed.customerId, {
    status: parsed.status,
    limit: parsed.limit,
  })
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
