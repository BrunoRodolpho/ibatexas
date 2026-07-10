// join_waitlist tool
// Adds a customer to the waitlist when a time slot is fully booked.
// Auth: customer
//
// ── W7 P1 follow-up — kernel-routed via reservation.joinWaitlistFromEnvelope ─
//
// Previously this tool invoked `svc.joinWaitlist(...)` directly, bypassing the
// adjudicate kernel. Per CLAUDE.md rule #9 (LLM authority) every mutating
// tool dispatch must flow through an IntentEnvelope. We now build a
// `reservation.waitlist.join` envelope (UNTRUSTED, principal=llm) and route
// via `joinWaitlistFromEnvelope`, which:
//   - Adjudicates against `reservationsPolicyBundle`
//   - Runs the validate-party-size + blocked-customer business guards;
//     terminates at `executeWaitlist` for the waitlist join kind
//   - Emits a governance audit record via the configured AuditSink
//   - Delegates to the existing `joinWaitlist()` for the Prisma writes
//
// State projection: the waitlist-join pack guards only inspect partySize +
// the customer.blocked flag — there's no slot-capacity check at this layer
// (the waitlist exists *because* the slot is full). We project a minimal
// state matching the cancel/create siblings (channel + customerId + now).

import { randomUUID } from "node:crypto"
import { createReservationService } from "@ibatexas/domain"
import { getAuditSink } from "@ibatexas/audit-sink"
import { JoinWaitlistInputSchema, type JoinWaitlistInput, type JoinWaitlistOutput } from "@ibatexas/types"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationState,
  ReservationWaitlistJoinPayload,
} from "@ibatexas/pack-reservations"

export async function joinWaitlist(input: JoinWaitlistInput): Promise<JoinWaitlistOutput> {
  const parsed = JoinWaitlistInputSchema.parse(input)

  const state: ReservationState = {
    ctx: {
      channel: "whatsapp",
      customerId: parsed.customerId,
      staffId: null,
      now: new Date(),
    },
  }

  // ── Build the IntentEnvelope ────────────────────────────────────────
  const payload: ReservationWaitlistJoinPayload = {
    timeSlotId: parsed.timeSlotId,
    partySize: parsed.partySize,
  }
  const envelope = buildEnvelope<
    "reservation.waitlist.join",
    ReservationWaitlistJoinPayload
  >({
    kind: "reservation.waitlist.join",
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: `customer:${parsed.customerId}`,
    },
    taint: "UNTRUSTED",
  })

  // BKL-046: thread the configured AuditSink so the kernel EXECUTE persists a
  // governance audit record — `createReservationService()` silently drops audit
  // emission when no sink is supplied (same idiom as create-reservation.ts).
  const svc = createReservationService({ auditSink: getAuditSink() })
  const outcome = await svc.joinWaitlistFromEnvelope(envelope, state, {
    customerId: parsed.customerId,
  })

  if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
    // Surface the kernel's refusal copy. The mutation did NOT run.
    const message =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.userFacing
        : "Não foi possível entrar na lista de espera no momento."
    throw new Error(message)
  }

  const { waitlistId, position } = outcome.result!

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
