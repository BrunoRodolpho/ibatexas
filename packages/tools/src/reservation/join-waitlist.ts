// join_waitlist tool
// Adds a customer to the waitlist when a time slot is fully booked.
// Auth: customer

import { prisma } from "@ibatexas/domain"
import { JoinWaitlistInputSchema, type JoinWaitlistInput, type JoinWaitlistOutput } from "@ibatexas/types"

export async function joinWaitlist(input: JoinWaitlistInput): Promise<JoinWaitlistOutput> {
  const parsed = JoinWaitlistInputSchema.parse(input)

  // 1. Verify slot exists
  const slot = await prisma.timeSlot.findUnique({ where: { id: parsed.timeSlotId } })

  if (!slot) {
    throw new Error("Horário não encontrado.")
  }

  // 2. Check if customer is already on the waitlist for this slot
  const alreadyWaiting = await prisma.waitlist.findFirst({
    where: {
      customerId: parsed.customerId,
      timeSlotId: parsed.timeSlotId,
      notifiedAt: null, // not yet notified (still pending)
    },
  })

  if (alreadyWaiting) {
    // Calculate position
    const position = await prisma.waitlist.count({
      where: {
        timeSlotId: parsed.timeSlotId,
        createdAt: { lte: alreadyWaiting.createdAt },
        notifiedAt: null,
      },
    })

    return {
      waitlistId: alreadyWaiting.id,
      position,
      message: `Você já está na lista de espera nesta posição: ${position}. Avisaremos pelo WhatsApp quando uma vaga abrir.`,
    }
  }

  // 3. Create waitlist entry (expires in 24h by default — extended on notification)
  const waitlistExpiryHours = Number.parseInt(process.env.WAITLIST_EXPIRY_HOURS || "24", 10)
  const expiresAt = new Date(Date.now() + waitlistExpiryHours * 60 * 60 * 1000)

  const entry = await prisma.waitlist.create({
    data: {
      customerId: parsed.customerId,
      timeSlotId: parsed.timeSlotId,
      partySize: parsed.partySize,
      expiresAt,
    },
  })

  // 4. Calculate position = count of entries created before this one (including this one)
  const position = await prisma.waitlist.count({
    where: {
      timeSlotId: parsed.timeSlotId,
      createdAt: { lte: entry.createdAt },
      notifiedAt: null,
    },
  })

  return {
    waitlistId: entry.id,
    position,
    message: `Você está na posição ${position} da lista de espera para este horário. Você será avisado pelo WhatsApp assim que uma vaga abrir.`,
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
