// cancel_reservation tool
// Cancels a reservation and notifies the next waitlist entry if applicable.
// Auth: customer

import { prisma } from "@ibatexas/domain"
import type { CancelReservationInput, CancelReservationOutput } from "@ibatexas/types"
import { CancelReservationInputSchema } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { notifyWaitlistSpotAvailable } from "./notifications.js"

export async function cancelReservation(
  input: CancelReservationInput,
): Promise<CancelReservationOutput> {
  const parsed = CancelReservationInputSchema.parse(input)

  // 1. Load and verify ownership
  const reservation = await prisma.reservation.findUnique({
    where: { id: parsed.reservationId },
    include: { timeSlot: true },
  })

  if (!reservation) {
    return { success: false, message: "Reserva não encontrada." }
  }

  if (reservation.customerId !== parsed.customerId) {
    return { success: false, message: "Você não tem permissão para cancelar esta reserva." }
  }

  if (["cancelled", "no_show", "completed"].includes(reservation.status)) {
    return {
      success: false,
      message: `Esta reserva já está com status "${reservation.status}" e não pode ser cancelada.`,
    }
  }

  // 2. Mark as cancelled + release resources (in a single transaction)
  await prisma.$transaction([
    prisma.reservation.update({
      where: { id: parsed.reservationId },
      data: { status: "cancelled", cancelledAt: new Date() },
    }),
    prisma.reservationTable.deleteMany({ where: { reservationId: parsed.reservationId } }),
    prisma.timeSlot.update({
      where: { id: reservation.timeSlotId },
      data: { reservedCovers: { decrement: reservation.partySize } },
    }),
  ])

  // 3. Check waitlist for this slot — notify next in line
  const nextInLine = await prisma.waitlist.findFirst({
    where: { timeSlotId: reservation.timeSlotId, notifiedAt: null },
    orderBy: { createdAt: "asc" },
  })

  if (nextInLine) {
    const waitlistOfferMinutes = parseInt(process.env.WAITLIST_OFFER_MINUTES || "30", 10)
    const expiresAt = new Date(Date.now() + waitlistOfferMinutes * 60 * 1000)

    await prisma.waitlist.update({
      where: { id: nextInLine.id },
      data: { notifiedAt: new Date(), expiresAt },
    })

    // Derive position = 1 (they're now being offered the spot)
    const waitlistDTO = {
      id: nextInLine.id,
      customerId: nextInLine.customerId,
      timeSlotId: nextInLine.timeSlotId,
      partySize: nextInLine.partySize,
      position: 1,
      notifiedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      createdAt: nextInLine.createdAt.toISOString(),
    }

    await notifyWaitlistSpotAvailable(
      waitlistDTO,
      reservation.timeSlot.date.toISOString().split("T")[0]!,
      reservation.timeSlot.startTime,
    )
  }

  // 4. Publish NATS event
  await publishNatsEvent("reservation.cancelled", {
    eventType: "reservation.cancelled",
    customerId: parsed.customerId,
    sessionId: parsed.customerId,
    channel: "web",
    timestamp: new Date().toISOString(),
    metadata: {
      reservationId: parsed.reservationId,
      reason: parsed.reason ?? null,
    },
  })

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
