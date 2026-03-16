// create_reservation tool
// Books a table for an authenticated customer.
// Auth: customer

import { prisma } from "@ibatexas/domain"
import { CreateReservationInputSchema, TableLocation, ReservationStatus, type CreateReservationInput, type CreateReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { assignTables, buildDateTime, formatDateBR, locationLabel } from "./utils.js"
import { sendReservationConfirmation } from "./notifications.js"

export async function createReservation(
  input: CreateReservationInput,
): Promise<CreateReservationOutput> {
  const parsed = CreateReservationInputSchema.parse(input)

  // 1. Load time slot + verify capacity
  const slot = await prisma.timeSlot.findUnique({ where: { id: parsed.timeSlotId } })

  if (!slot) {
    throw new Error("Horário não encontrado. Verifique o ID do horário.")
  }

  const availableCovers = slot.maxCovers - slot.reservedCovers

  if (availableCovers < parsed.partySize) {
    throw new Error(
      `Este horário está esgotado para ${parsed.partySize} pessoa(s). Tente outro horário ou entre na lista de espera.`,
    )
  }

  // 2. Assign tables
  const tableIds = await assignTables(parsed.timeSlotId, parsed.partySize)

  // 3. Fetch assigned table details for location
  const tables = await prisma.table.findMany({
    where: { id: { in: tableIds } },
    select: { id: true, location: true },
  })

  const firstTable = tables[0]
  const tableLocation: TableLocation | null = firstTable ? (firstTable.location as TableLocation) : null

  // 4. Create reservation + tables + increment covers (transaction)
  const reservation = await prisma.$transaction(async (tx) => {
    const r = await tx.reservation.create({
      data: {
        customerId: parsed.customerId,
        partySize: parsed.partySize,
        status: "confirmed",
        specialRequests: parsed.specialRequests ?? [],
        confirmedAt: new Date(),
        timeSlotId: parsed.timeSlotId,
        tables: {
          create: tableIds.map((tableId) => ({ tableId })),
        },
      },
      include: { timeSlot: true, tables: { include: { table: true } } },
    })

    await tx.timeSlot.update({
      where: { id: parsed.timeSlotId },
      data: { reservedCovers: { increment: parsed.partySize } },
    })

    return r
  })

  const dateTime = buildDateTime(slot.date, slot.startTime)
  const dateBR = formatDateBR(slot.date)
  const loc = locationLabel(tableLocation)

  const confirmationMessage = [
    `✅ Reserva confirmada!`,
    `📅 ${dateBR} às ${slot.startTime}`,
    `👥 ${parsed.partySize} pessoa(s) — ${loc}`,
    `ID da reserva: ${reservation.id}`,
  ].join("\n")

  // 5. Publish NATS event (fire-and-forget)
  await publishNatsEvent("reservation.created", {
    eventType: "reservation.created",
    customerId: parsed.customerId,
    sessionId: parsed.customerId,
    channel: "web",
    timestamp: new Date().toISOString(),
    metadata: {
      reservationId: reservation.id,
      partySize: parsed.partySize,
      date: slot.date.toISOString().split("T")[0],
      startTime: slot.startTime,
      tableLocation,
    },
  })

  // 6. WhatsApp confirmation (stub — Step 12 wires in Twilio)
  const reservationDTO = {
    id: reservation.id,
    customerId: parsed.customerId,
    partySize: parsed.partySize,
    status: ReservationStatus.CONFIRMED,
    specialRequests: parsed.specialRequests ?? [],
    timeSlot: {
      id: slot.id,
      date: slot.date.toISOString().split("T")[0] ?? "",
      startTime: slot.startTime,
      durationMinutes: slot.durationMinutes,
    },
    tableLocation,
    confirmedAt: reservation.confirmedAt?.toISOString() ?? null,
    checkedInAt: null,
    cancelledAt: null,
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
  }

  await sendReservationConfirmation(reservationDTO)

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
