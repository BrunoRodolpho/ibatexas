// create_reservation tool
// Books a table for an authenticated customer.
// Auth: customer
//
// ── W7 P1 — kernel-routed via reservation.createFromEnvelope ──────────────
//
// Previously this tool invoked `svc.create(...)` directly, bypassing the
// adjudicate kernel. Per CLAUDE.md rule #9 (LLM authority) every mutating
// tool dispatch must flow through an IntentEnvelope. We now build an
// `reservation.create` envelope (UNTRUSTED, principal=llm) and route via
// `createFromEnvelope`, which:
//   - Adjudicates against `reservationsPolicyBundle`
//   - Runs the slot capacity / future-slot / party-size / no-show-escalate
//     / blocked-customer guards
//   - Emits a governance audit record via the configured AuditSink
//   - Delegates to the existing `create()` for the Prisma write
//
// State projection: the pack's `requireSlotWithCapacity` and
// `requireSlotInFuture` guards inspect `state.ctx.slot` + `state.ctx.now`.
// We hydrate them with a single `timeSlot.findUnique` lookup before the
// kernel runs so the pack has the data it needs to reach EXECUTE (the
// service's inner `create()` re-reads under FOR UPDATE for serializability;
// the policy read is advisory).

import { randomUUID } from "node:crypto"
import { createReservationService, prisma } from "@ibatexas/domain"
import { CreateReservationInputSchema, ReservationStatus, type CreateReservationInput, type CreateReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationCreatePayload,
  ReservationState,
} from "@ibatexas/pack-reservations"
import { buildDateTime, formatDateBR, locationLabel } from "./utils.js"
import { sendReservationConfirmation } from "./notifications.js"

export async function createReservation(
  input: CreateReservationInput,
): Promise<CreateReservationOutput> {
  const parsed = CreateReservationInputSchema.parse(input)

  // ── Project state for the pack policies ────────────────────────────
  // The pack's `requireSlotWithCapacity` REFUSEs when `state.ctx.slot` is
  // absent. We do a cheap lookup here; the inner `create()` re-reads with
  // FOR UPDATE inside its transaction so this read is purely advisory.
  const slotRow = await prisma.timeSlot.findUnique({
    where: { id: parsed.timeSlotId },
  })

  const state: ReservationState = {
    ctx: {
      channel: "whatsapp",
      customerId: parsed.customerId,
      staffId: null,
      now: new Date(),
      slot: slotRow
        ? {
            timeSlotId: slotRow.id,
            startAt: new Date(
              `${slotRow.date.toISOString().split("T")[0]}T${slotRow.startTime}:00`,
            ),
            maxCovers: slotRow.maxCovers,
            reservedCovers: slotRow.reservedCovers,
          }
        : null,
    },
  }

  // ── Build the IntentEnvelope ────────────────────────────────────────
  // LLM-dispatched mutation → UNTRUSTED taint, principal="llm". The kernel
  // adjudicates against `reservationsPolicyBundle` and emits an audit
  // record before any Prisma write.
  // Pack payload declares `specialRequests: ReadonlyArray<string>` but the
  // service-layer executor uses the rich `SpecialRequest[]` shape from
  // @ibatexas/types via the existing cast at reservation.service.ts:581.
  // We pass the SpecialRequest[] through as-is so the structured `{type, notes}`
  // entries reach Prisma. The pack's policies do not inspect specialRequests.
  const payload: ReservationCreatePayload = {
    timeSlotId: parsed.timeSlotId,
    partySize: parsed.partySize,
    ...(parsed.specialRequests === undefined
      ? {}
      : { specialRequests: parsed.specialRequests as unknown as ReadonlyArray<string> }),
  }
  const envelope = buildEnvelope<"reservation.create", ReservationCreatePayload>({
    kind: "reservation.create",
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: `customer:${parsed.customerId}`,
    },
    taint: "UNTRUSTED",
  })

  const svc = createReservationService()
  const outcome = await svc.createFromEnvelope(envelope, state, {
    customerId: parsed.customerId,
  })

  if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
    // Surface the kernel's refusal copy. The mutation did NOT run.
    const message =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.userFacing
        : "Não foi possível criar a reserva no momento."
    throw new Error(message)
  }

  const { reservation, tableLocation } = outcome.result!

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
