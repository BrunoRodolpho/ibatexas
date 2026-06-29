// modify_reservation tool
// Changes date, time, party size, or special requests on an existing reservation.
// Auth: customer
//
// ── W7 P1 — kernel-routed via reservation.modifyFromEnvelope ──────────────
//
// Previously this tool invoked `svc.modify(...)` directly, bypassing the
// adjudicate kernel. Per CLAUDE.md rule #9 (LLM authority) every mutating
// tool dispatch must flow through an IntentEnvelope. We now build a
// `reservation.modify` envelope (UNTRUSTED, principal=llm) and route via
// `modifyFromEnvelope`, which:
//   - Adjudicates against `reservationsPolicyBundle`
//   - Runs the reservation-present / modifiable / party-size /
//     full-new-slot guards
//   - Emits a governance audit record via the configured AuditSink
//   - Delegates to the existing `modify()` for the Prisma write (which
//     re-locks `FOR UPDATE` inside its transaction; the policy read is
//     advisory)
//
// State projection: the pack's `requireReservationPresent` /
// `requireReservationModifiable` guards inspect `state.ctx.reservation`.
// The `refuseModifyOnFullNewSlot` guard inspects `state.ctx.newSlot`. We
// hydrate them via cheap lookups before the kernel runs.

import { randomUUID } from "node:crypto"
import { createReservationService, prisma } from "@ibatexas/domain"
import { ModifyReservationInputSchema, type ModifyReservationInput, type ModifyReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationModifyPayload,
  ReservationState,
} from "@ibatexas/pack-reservations"
import { withReservationOwnership } from "../guards/with-ownership.js"
import { sendReservationModified } from "./notifications.js"

// SEC-002: Ownership guard wrapper — rejects before any business logic
export const modifyReservation = withReservationOwnership(modifyReservationImpl)

async function modifyReservationImpl(
  input: ModifyReservationInput,
): Promise<ModifyReservationOutput> {
  const parsed = ModifyReservationInputSchema.parse(input)

  const svc = createReservationService()

  try {
    // ── Project state for the pack policies ──────────────────────────
    // SEC-002's ownership guard already loaded the reservation, but we
    // need our own projection here (fresh status, current timeSlotId).
    const existing = await prisma.reservation.findUnique({
      where: { id: parsed.reservationId },
      select: {
        id: true,
        status: true,
        partySize: true,
        timeSlotId: true,
      },
    })

    // If null, let the inner modify() throw with the canonical error copy.
    // (We pass null reservation into state — the pack's
    // `requireReservationPresent` guard will REFUSE with refuseReservationNotFound().)
    const isChangingSlot =
      parsed.newTimeSlotId !== undefined &&
      existing !== null &&
      parsed.newTimeSlotId !== existing.timeSlotId

    const newSlotRow = isChangingSlot
      ? await prisma.timeSlot.findUnique({ where: { id: parsed.newTimeSlotId! } })
      : null

    const state: ReservationState = {
      ctx: {
        channel: "whatsapp",
        customerId: parsed.customerId,
        staffId: null,
        now: new Date(),
        reservation: existing
          ? {
              id: existing.id,
              status: existing.status as
                | "pending"
                | "confirmed"
                | "seated"
                | "completed"
                | "cancelled"
                | "no_show",
              partySize: existing.partySize,
              timeSlotId: existing.timeSlotId,
            }
          : null,
        newSlot: newSlotRow
          ? {
              timeSlotId: newSlotRow.id,
              startAt: new Date(
                `${newSlotRow.date.toISOString().split("T")[0]}T${newSlotRow.startTime}:00`,
              ),
              maxCovers: newSlotRow.maxCovers,
              reservedCovers: newSlotRow.reservedCovers,
            }
          : null,
      },
    }

    // ── Build the IntentEnvelope ──────────────────────────────────────
    const payload: ReservationModifyPayload = {
      reservationId: parsed.reservationId,
      ...(parsed.newTimeSlotId === undefined ? {} : { newTimeSlotId: parsed.newTimeSlotId }),
      ...(parsed.newPartySize === undefined ? {} : { newPartySize: parsed.newPartySize }),
      ...(parsed.specialRequests === undefined
        ? {}
        : { specialRequests: parsed.specialRequests as unknown as ReadonlyArray<string> }),
    }
    const envelope = buildEnvelope<"reservation.modify", ReservationModifyPayload>({
      kind: "reservation.modify",
      payload,
      nonce: randomUUID(),
      actor: {
        principal: "llm",
        sessionId: `customer:${parsed.customerId}`,
      },
      taint: "UNTRUSTED",
    })

    const outcome = await svc.modifyFromEnvelope(envelope, state, {
      customerId: parsed.customerId,
    })

    if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
      const message =
        outcome.decision.kind === "REFUSE"
          ? outcome.decision.refusal.userFacing
          : "Não foi possível modificar a reserva no momento."
      return {
        success: false,
        reservation: null,
        message,
      }
    }

    const dto = outcome.result!

    // Notify customer of modification (fire-and-forget)
    void sendReservationModified(dto).catch((err) =>
      console.error("[modify_reservation] Notification error:", (err as Error).message),
    )

    void publishNatsEvent("reservation.modified", {
      eventType: "reservation.modified",
      customerId: parsed.customerId,
      sessionId: parsed.customerId,
      channel: "web",
      timestamp: new Date().toISOString(),
      metadata: { reservationId: parsed.reservationId },
    }).catch((err) => console.error("[modify_reservation] NATS publish error:", (err as Error).message))

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
