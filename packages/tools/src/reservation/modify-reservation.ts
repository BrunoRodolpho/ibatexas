// modify_reservation tool
// Changes date, time, party size, or special requests on an existing reservation.
// Auth: customer

import { createReservationService } from "@ibatexas/domain"
import { ModifyReservationInputSchema, type ModifyReservationInput, type ModifyReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { sendReservationModified } from "./notifications.js"

export async function modifyReservation(
  input: ModifyReservationInput,
): Promise<ModifyReservationOutput> {
  const parsed = ModifyReservationInputSchema.parse(input)

  const svc = createReservationService()

  try {
    const dto = await svc.modify(parsed.reservationId, parsed.customerId, {
      newTimeSlotId: parsed.newTimeSlotId,
      newPartySize: parsed.newPartySize,
      specialRequests: parsed.specialRequests,
    })

    // Notify customer of modification (fire-and-forget)
    void sendReservationModified(dto).catch((err) =>
      console.error("[modify_reservation] Notification error:", err),
    )

    void publishNatsEvent("reservation.modified", {
      eventType: "reservation.modified",
      customerId: parsed.customerId,
      sessionId: parsed.customerId,
      channel: "web",
      timestamp: new Date().toISOString(),
      metadata: { reservationId: parsed.reservationId },
    }).catch((err) => console.error("[modify_reservation] NATS publish error:", err))

    return {
      success: true,
      reservation: dto,
      message: `Reserva modificada: ${dto.timeSlot.startTime} em ${dto.timeSlot.date}, ${dto.partySize} pessoa(s).`,
    }
  } catch (err) {
    return {
      success: false,
      reservation: null,
      message: (err as Error).message,
    }
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const ModifyReservationTool = {
  name: "modify_reservation",
  description:
    "Modifica uma reserva existente: data, horário, número de pessoas ou solicitações especiais. Só o titular da reserva pode modificar.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "ID do cliente" },
      reservationId: { type: "string", description: "ID da reserva a modificar" },
      newTimeSlotId: { type: "string", description: "ID do novo horário (opcional)" },
      newPartySize: { type: "number", description: "Novo número de pessoas (opcional)" },
      specialRequests: {
        type: "array",
        description: "Novas solicitações especiais (substitui as anteriores)",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["birthday", "anniversary", "allergy_warning", "highchair", "window_seat", "accessible", "other"],
            },
            notes: { type: "string" },
          },
          required: ["type"],
        },
      },
    },
    required: ["customerId", "reservationId"],
  },
}
