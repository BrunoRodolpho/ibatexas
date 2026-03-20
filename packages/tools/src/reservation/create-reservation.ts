// create_reservation tool
// Books a table for an authenticated customer.
// Auth: customer

import { createReservationService } from "@ibatexas/domain"
import { CreateReservationInputSchema, ReservationStatus, type CreateReservationInput, type CreateReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { buildDateTime, formatDateBR, locationLabel } from "./utils.js"
import { sendReservationConfirmation } from "./notifications.js"

export async function createReservation(
  input: CreateReservationInput,
): Promise<CreateReservationOutput> {
  const parsed = CreateReservationInputSchema.parse(input)

  const svc = createReservationService()
  const { reservation, tableLocation } = await svc.create({
    customerId: parsed.customerId,
    timeSlotId: parsed.timeSlotId,
    partySize: parsed.partySize,
    specialRequests: parsed.specialRequests,
  })

  const dateTime = buildDateTime(new Date(reservation.timeSlot.date), reservation.timeSlot.startTime)
  const dateBR = formatDateBR(new Date(reservation.timeSlot.date))
  const loc = locationLabel(tableLocation)

  const confirmationMessage = [
    `✅ Reserva confirmada!`,
    `📅 ${dateBR} às ${reservation.timeSlot.startTime}`,
    `👥 ${parsed.partySize} pessoa(s) — ${loc}`,
    `ID da reserva: ${reservation.id}`,
  ].join("\n")

  void publishNatsEvent("reservation.created", {
    eventType: "reservation.created",
    customerId: parsed.customerId,
    sessionId: parsed.customerId,
    channel: "web",
    timestamp: new Date().toISOString(),
    metadata: {
      reservationId: reservation.id,
      partySize: parsed.partySize,
      date: reservation.timeSlot.date,
      startTime: reservation.timeSlot.startTime,
      tableLocation,
    },
  }).catch((err) => console.error("[create_reservation] NATS publish error:", (err as Error).message))

  await sendReservationConfirmation({
    ...reservation,
    status: ReservationStatus.CONFIRMED,
  })

  return {
    reservationId: reservation.id,
    confirmed: true,
    tableLocation,
    dateTime,
    partySize: parsed.partySize,
    confirmationMessage,
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const CreateReservationTool = {
  name: "create_reservation",
  description:
    "Cria uma reserva de mesa para o cliente autenticado. Requer horário disponível (use check_table_availability antes). Envia confirmação automática.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: {
        type: "string",
        description: "ID do cliente (Medusa customer id)",
      },
      timeSlotId: {
        type: "string",
        description: "ID do horário retornado por check_table_availability",
      },
      partySize: {
        type: "number",
        description: "Número de pessoas (1–20)",
      },
      specialRequests: {
        type: "array",
        description: "Solicitações especiais opcionais",
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
    required: ["customerId", "timeSlotId", "partySize"],
  },
}
