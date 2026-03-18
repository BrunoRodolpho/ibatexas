// join_waitlist tool
// Adds a customer to the waitlist when a time slot is fully booked.
// Auth: customer

import { createReservationService } from "@ibatexas/domain"
import { JoinWaitlistInputSchema, type JoinWaitlistInput, type JoinWaitlistOutput } from "@ibatexas/types"

export async function joinWaitlist(input: JoinWaitlistInput): Promise<JoinWaitlistOutput> {
  const parsed = JoinWaitlistInputSchema.parse(input)

  const svc = createReservationService()
  const { waitlistId, position } = await svc.joinWaitlist({
    customerId: parsed.customerId,
    timeSlotId: parsed.timeSlotId,
    partySize: parsed.partySize,
  })

  return {
    waitlistId,
    position,
    message: position === 1 && waitlistId
      ? `Você já está na lista de espera nesta posição: ${position}. Avisaremos pelo WhatsApp quando uma vaga abrir.`
      : `Você está na posição ${position} da lista de espera para este horário. Você será avisado pelo WhatsApp assim que uma vaga abrir.`,
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const JoinWaitlistTool = {
  name: "join_waitlist",
  description:
    "Adiciona o cliente à lista de espera para um horário esgotado. O cliente será notificado pelo WhatsApp quando uma vaga abrir.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "ID do cliente" },
      timeSlotId: { type: "string", description: "ID do horário esgotado" },
      partySize: { type: "number", description: "Número de pessoas (1–20)" },
    },
    required: ["customerId", "timeSlotId", "partySize"],
  },
}
