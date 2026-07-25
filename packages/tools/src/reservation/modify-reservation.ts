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
//
// ── BKL-232 — two entry points, so a conductor turn adjudicates ONCE ──────
//
// This tool has two callers, and only ONE of them has already adjudicated:
//
//   - `modifyReservation` (SELF-ADJUDICATING) — the REST `PATCH
//     /api/reservations/:id` route (apps/api/src/routes/reservations.ts),
//     which reaches the tool with no kernel decision behind it. It MUST mint
//     and adjudicate its own envelope or the mutation would run ungated
//     (CLAUDE.md rule #9).
//   - `modifyReservationPreAdjudicated` (BKL-232) — the claustrum tool
//     registry (apps/api/src/tools/register-ibatexas-tool-packs.ts). The
//     Conductor has ALREADY adjudicated this exact `reservation.modify`
//     envelope through the audited kernel AND claimed its execution-ledger
//     key; re-minting a second envelope here produced a SECOND
//     `reservation.modify` EXECUTE per single customer confirm.
//
// Why the execution ledger could not absorb the duplicate: the ledger dedups
// on `intentHash` (`ledger:intent:<hash>`, SET NX). The envelope minted below
// is a DIFFERENT envelope from the Conductor's — fresh `nonce: randomUUID()`,
// a payload without `customerId`, and `actor.sessionId = customer:<id>` rather
// than the conversation session — so its hash can never collide with the
// adjudicated one, and `withAdjudicate` is wired with no ledger at all. The
// only fix is to not adjudicate the same intent twice.
//
// The order-plane amend/cancel tools were never exposed to this: they do not
// re-mint an envelope of the kind the Conductor decided. Their inner envelopes
// (`payment.status.transition`, `payment.cancel`, `payment.create`,
// `order.type.switch`) are genuinely distinct downstream mutations.
//
// Write-time invariants are unaffected on the pre-adjudicated path:
// `reservationService.modify` re-reads the reservation, re-asserts ownership +
// mutability, and re-checks new-slot capacity under a `FOR UPDATE` lock inside
// its own transaction (reservation.service.ts) — the pack guards the Conductor
// already ran are advisory reads, exactly as this file's header has always said.

import { randomUUID } from "node:crypto"
import { createReservationService, prisma } from "@ibatexas/domain"
import { getAuditSink } from "@ibatexas/audit-sink"
import {
  ModifyReservationInputSchema,
  type ModifyReservationInput,
  type ModifyReservationOutput,
  type ReservationDTO,
  type SpecialRequest,
} from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationModifyPayload,
  ReservationState,
} from "@ibatexas/pack-reservations"
import { withReservationOwnership } from "../guards/with-ownership.js"
import { sendReservationModified } from "./notifications.js"

/**
 * How the caller reached this tool — i.e. who owns the kernel decision.
 *
 * `"self"`      — nobody adjudicated yet; mint + adjudicate an envelope here.
 * `"conductor"` — the claustrum Conductor already adjudicated this intent and
 *                 claimed its execution-ledger key; execute, do NOT re-adjudicate
 *                 (BKL-232).
 */
type ModifyAuthority = "self" | "conductor"

/**
 * The post-write side effects + pt-BR result, shared by both entry points so the
 * pre-adjudicated path cannot drift from the self-adjudicating one. Notification
 * and NATS publish stay fire-and-forget (a delivery failure must not fail a
 * mutation that already committed).
 */
function succeed(
  dto: ReservationDTO,
  parsed: ModifyReservationInput,
): ModifyReservationOutput {
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
}

// SEC-002: Ownership guard wrapper — rejects before any business logic
export const modifyReservation = withReservationOwnership(
  (input: ModifyReservationInput) => modifyReservationImpl(input, "self"),
)

/**
 * BKL-232 — the entry point the claustrum tool registry dispatches on a kernel
 * EXECUTE. Identical to {@link modifyReservation} (same ownership guard, same
 * write, same notification + NATS side effects, same pt-BR result shape) except
 * that it does NOT re-adjudicate: the Conductor's audited, ledger-claimed
 * decision is the single authorization for this mutation.
 */
export const modifyReservationPreAdjudicated = withReservationOwnership(
  (input: ModifyReservationInput) => modifyReservationImpl(input, "conductor"),
)

async function modifyReservationImpl(
  input: ModifyReservationInput,
  authority: ModifyAuthority,
): Promise<ModifyReservationOutput> {
  const parsed = ModifyReservationInputSchema.parse(input)

  // BKL-046: thread the configured AuditSink so the kernel EXECUTE persists a
  // governance audit record — `createReservationService()` silently drops audit
  // emission when no sink is supplied (same idiom as create-reservation.ts).
  const svc = createReservationService({ auditSink: getAuditSink() })

  try {
    // ── BKL-232 — the Conductor already authorized this intent ─────────
    // Execute the mutation under its decision. No second envelope, no second
    // adjudication, no second `reservation.modify` EXECUTE audit row. The
    // pack-guard state projection below exists only to feed a kernel run, so
    // it is skipped here too (it was two redundant reads on this path).
    if (authority === "conductor") {
      const changes: {
        newTimeSlotId?: string
        newPartySize?: number
        specialRequests?: SpecialRequest[]
      } = {}
      if (parsed.newTimeSlotId !== undefined) changes.newTimeSlotId = parsed.newTimeSlotId
      if (parsed.newPartySize !== undefined) changes.newPartySize = parsed.newPartySize
      if (parsed.specialRequests !== undefined) {
        changes.specialRequests = parsed.specialRequests as SpecialRequest[]
      }
      const dto = await svc.modify(parsed.reservationId, parsed.customerId, changes)
      return succeed(dto, parsed)
    }

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

    return succeed(outcome.result!, parsed)
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
