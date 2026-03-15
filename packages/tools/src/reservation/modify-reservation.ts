// modify_reservation tool
// Changes date, time, party size, or special requests on an existing reservation.
// Auth: customer

import { prisma } from "@ibatexas/domain"
import { ModifyReservationInputSchema, TableLocation, type ModifyReservationInput, type ModifyReservationOutput, type ReservationDTO, type SpecialRequest } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { assignTables, reservationToDTO, type ReservationWithRelations } from "./utils.js"

export async function modifyReservation(
  input: ModifyReservationInput,
): Promise<ModifyReservationOutput> {
  const parsed = ModifyReservationInputSchema.parse(input)

  // 1. Load and verify ownership
  const existing = await prisma.reservation.findUnique({
    where: { id: parsed.reservationId },
    include: { timeSlot: true, tables: { include: { table: true } } },
  })

  if (!existing) {
    return { success: false, reservation: null, message: "Reserva não encontrada." }
  }

  if (existing.customerId !== parsed.customerId) {
    return { success: false, reservation: null, message: "Você não tem permissão para modificar esta reserva." }
  }

  if (["cancelled", "no_show", "completed"].includes(existing.status)) {
    return {
      success: false,
      reservation: null,
      message: `Não é possível modificar uma reserva com status "${existing.status}".`,
    }
  }

  const newTimeSlotId = parsed.newTimeSlotId ?? existing.timeSlotId
  const newPartySize = parsed.newPartySize ?? existing.partySize
  const isChangingSlot = newTimeSlotId !== existing.timeSlotId
  const isChangingPartySize = newPartySize !== existing.partySize

  // 2. Validate new slot if changed
  if (isChangingSlot) {
    const newSlot = await prisma.timeSlot.findUnique({ where: { id: newTimeSlotId } })
    if (!newSlot) {
      return { success: false, reservation: null, message: "Novo horário não encontrado." }
    }
    const available = newSlot.maxCovers - newSlot.reservedCovers
    if (available < newPartySize) {
      return {
        success: false,
        reservation: null,
        message: `O horário solicitado não tem vagas para ${newPartySize} pessoa(s).`,
      }
    }
  }

  // 3. Release old slot covers + tables, then reassign
  const changes: Record<string, unknown> = {}
  if (isChangingSlot) changes.previousTimeSlotId = existing.timeSlotId
  if (isChangingPartySize) changes.previousPartySize = existing.partySize

  const updated = await prisma.$transaction(async (tx) => {
    // Release old covers
    await tx.timeSlot.update({
      where: { id: existing.timeSlotId },
      data: { reservedCovers: { decrement: existing.partySize } },
    })

    // Remove old table assignments
    await tx.reservationTable.deleteMany({ where: { reservationId: existing.id } })

    // Assign new tables
    const newTableIds = await assignTables(newTimeSlotId, newPartySize)

    // Increment new slot covers
    await tx.timeSlot.update({
      where: { id: newTimeSlotId },
      data: { reservedCovers: { increment: newPartySize } },
    })

    // Update reservation
    const r = await tx.reservation.update({
      where: { id: existing.id },
      data: {
        timeSlotId: newTimeSlotId,
        partySize: newPartySize,
        specialRequests: (parsed.specialRequests ?? (existing.specialRequests as SpecialRequest[]) ?? []),
        tables: {
          create: newTableIds.map((tableId) => ({ tableId })),
        },
      },
      include: { timeSlot: true, tables: { include: { table: true } } },
    })

    return r
  })

  // 4. Publish NATS event
  await publishNatsEvent("reservation.modified", {
    eventType: "reservation.modified",
    customerId: parsed.customerId,
    sessionId: parsed.customerId,
    channel: "web",
    timestamp: new Date().toISOString(),
    metadata: { reservationId: existing.id, changes },
  })

  const dto = reservationToDTO(updated as unknown as ReservationWithRelations)

  return {
    success: true,
    reservation: dto,
    message: `Reserva modificada: ${dto.timeSlot.startTime} em ${dto.timeSlot.date}, ${newPartySize} pessoa(s).`,
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
