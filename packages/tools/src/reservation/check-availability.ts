// check_table_availability tool
// Finds available time slots for a given date and party size.
// Auth: guest

import { createReservationService } from "@ibatexas/domain"
import {
  CheckAvailabilityInputSchema,
  type CheckAvailabilityInput,
  type CheckAvailabilityOutput,
} from "@ibatexas/types"

export async function checkTableAvailability(
  input: CheckAvailabilityInput,
): Promise<CheckAvailabilityOutput> {
  const parsed = CheckAvailabilityInputSchema.parse(input)

  const svc = createReservationService()
  const slots = await svc.checkAvailability(parsed.date, parsed.partySize, parsed.preferredTime)

  const message =
    slots.length === 0
      ? `Não encontrei vagas para ${parsed.partySize} pessoa(s) em ${parsed.date}. Tente outra data.`
      : `Encontrei ${slots.length} horário(s) disponível(is) para ${parsed.partySize} pessoa(s) em ${parsed.date}.`

  return { slots, message }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const CheckTableAvailabilityTool = {
  name: "check_table_availability",
  description:
    "Verifica horários disponíveis para reserva de mesa em uma data e número de pessoas. Use antes de criar uma reserva.",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "Data da reserva no formato YYYY-MM-DD (ex: 2026-03-15)",
      },
      partySize: {
        type: "number",
        description: "Número de pessoas (1–20)",
      },
      preferredTime: {
        type: "string",
        description: "Horário preferido no formato HH:MM (ex: 19:30) — opcional",
      },
    },
    required: ["date", "partySize"],
  },
}
