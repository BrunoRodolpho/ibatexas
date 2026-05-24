// join_waitlist tool
// Adds a customer to the waitlist when a time slot is fully booked.
// Auth: customer
//
// ── W7 P1 — BLOCKED on missing service-side envelope entry point ────────
//
// This tool still calls `svc.joinWaitlist(...)` directly. Per the W6
// governance-coverage scan, this is a kernel bypass for an LLM-proposable
// mutation — but unlike `reservation.create/modify/cancel`, the
// `reservation.service.ts` does NOT yet expose a `joinWaitlistFromEnvelope`
// method. The pack-reservations package declares `reservation.waitlist.join`
// as a valid UNTRUSTED-tolerant intent kind (packages/pack-reservations/src/types.ts:55),
// but the corresponding service-layer wrapper does not exist.
//
// Migrating this site requires a service-side change (adding
// `joinWaitlistFromEnvelope` to reservation.service.ts) which is OUT OF
// SCOPE for W7-Govern-Customer (the reservation.service.ts file is
// READ-ONLY for this agent per the W7 scope split). Surfaced as a
// sub-finding in the W7 closure report — to be picked up in a follow-up
// commit by an agent owning packages/domain.

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
