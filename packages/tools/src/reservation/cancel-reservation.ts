// cancel_reservation tool
// Cancels a reservation and notifies the next waitlist entry if applicable.
// Auth: customer

import { createReservationService } from "@ibatexas/domain"
import { CancelReservationInputSchema, type CancelReservationInput, type CancelReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { notifyWaitlistSpotAvailable, sendReservationCancelled } from "./notifications.js"

export async function cancelReservation(
  input: CancelReservationInput,
): Promise<CancelReservationOutput> {
  const parsed = CancelReservationInputSchema.parse(input)

  const svc = createReservationService()

  // Fetch reservation details before cancelling (for notification)
  const reservationDetails = await svc.getById(parsed.reservationId, parsed.customerId)

  const { timeSlotId } = await svc.cancel(parsed.reservationId, parsed.customerId)

  // Notify customer of cancellation (fire-and-forget)
  void sendReservationCancelled(
    parsed.reservationId,
    reservationDetails.timeSlot.date,
    reservationDetails.timeSlot.startTime,
  ).catch((err) => console.error("[cancel_reservation] Notification error:", err))

  // Promote next waitlist entry and notify
  const { promoted } = await svc.promoteWaitlist(timeSlotId)
  if (promoted) {
    await notifyWaitlistSpotAvailable(
      {
        id: promoted.id,
        customerId: promoted.customerId,
        timeSlotId,
        partySize: promoted.partySize,
        position: 1,
        notifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      },
      promoted.date,
      promoted.startTime,
    )
  }

  void publishNatsEvent("reservation.cancelled", {
    eventType: "reservation.cancelled",
    customerId: parsed.customerId,
    sessionId: parsed.customerId,
    channel: "web",
    timestamp: new Date().toISOString(),
    metadata: {
      reservationId: parsed.reservationId,
      reason: parsed.reason ?? null,
    },
  }).catch((err) => console.error("[cancel_reservation] NATS publish error:", err))

  return {
    success: true,
    message: "Reserva cancelada com sucesso. Você receberá uma confirmação em breve.",
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const CancelReservationTool = {
  name: "cancel_reservation",
  description:
    "Cancela uma reserva existente. Só o titular pode cancelar. Notifica automaticamente o próximo na lista de espera, se houver.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "ID do cliente" },
      reservationId: { type: "string", description: "ID da reserva a cancelar" },
      reason: { type: "string", description: "Motivo do cancelamento (opcional)" },
    },
    required: ["customerId", "reservationId"],
  },
}
