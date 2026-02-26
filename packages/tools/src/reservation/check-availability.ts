// check_table_availability tool
// Finds available time slots for a given date and party size.
// Auth: guest

import { prisma } from "@ibatexas/domain"
import type {
  CheckAvailabilityInput,
  CheckAvailabilityOutput,
  AvailableSlot,
} from "@ibatexas/types"
import { CheckAvailabilityInputSchema, TableLocation } from "@ibatexas/types"

export async function checkTableAvailability(
  input: CheckAvailabilityInput,
): Promise<CheckAvailabilityOutput> {
  const parsed = CheckAvailabilityInputSchema.parse(input)

  const date = new Date(parsed.date + "T00:00:00.000Z")

  // Load all time slots for this date
  const slots = await prisma.timeSlot.findMany({
    where: { date },
    orderBy: { startTime: "asc" },
  })

  if (slots.length === 0) {
    return {
      slots: [],
      message: `Não há horários disponíveis para ${parsed.date}.`,
    }
  }

  const result: AvailableSlot[] = []

  for (const slot of slots) {
    const availableCovers = slot.maxCovers - slot.reservedCovers
    if (availableCovers < parsed.partySize) continue

    // If preferred time filter is set, skip non-matching slots
    if (parsed.preferredTime && slot.startTime !== parsed.preferredTime) continue

    // Find distinct table locations that have free tables in this slot
    const reservedTableIds = await prisma.reservationTable.findMany({
      where: {
        reservation: {
          timeSlotId: slot.id,
          status: { notIn: ["cancelled", "no_show"] },
        },
      },
      select: { tableId: true },
    })

    const reservedIds = reservedTableIds.map((rt) => rt.tableId)

    const freeTables = await prisma.table.findMany({
      where: { active: true, id: { notIn: reservedIds } },
      select: { location: true },
    })

    const uniqueLocations = [...new Set(freeTables.map((t) => t.location as TableLocation))]

    result.push({
      timeSlotId: slot.id,
      date: parsed.date,
      startTime: slot.startTime,
      durationMinutes: slot.durationMinutes,
      availableCovers,
      tableLocations: uniqueLocations,
    })
  }

  const message =
    result.length === 0
      ? `Não encontrei vagas para ${parsed.partySize} pessoa(s) em ${parsed.date}. Tente outra data.`
      : `Encontrei ${result.length} horário(s) disponível(is) para ${parsed.partySize} pessoa(s) em ${parsed.date}.`

  return { slots: result, message }
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
