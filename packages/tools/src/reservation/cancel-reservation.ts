// cancel_reservation tool
// Cancels a reservation and notifies the next waitlist entry if applicable.
// Auth: customer
//
// ── W7 P1 — kernel-routed via reservation.cancelFromEnvelope ──────────────
//
// Previously this tool invoked `svc.cancel(...)` directly, bypassing the
// adjudicate kernel. Per CLAUDE.md rule #9 (LLM authority) every mutating
// tool dispatch must flow through an IntentEnvelope. We now build a
// `reservation.cancel` envelope (UNTRUSTED, principal=llm) and route via
// `cancelFromEnvelope`, which:
//   - Adjudicates against `reservationsPolicyBundle`
//   - Runs the reservation-present / cancellable / last-minute-confirm
//     guards (REQUEST_CONFIRMATION when within RESERVATION_CANCEL_CONFIRM_HOURS
//     of the slot start)
//   - Emits a governance audit record via the configured AuditSink
//   - Delegates to the existing `cancel()` for the Prisma writes
//
// The post-cancel side effects (waitlist promotion + NATS publish +
// customer notification) remain in the tool layer because they are not
// part of the cancel mutation itself — they react to the EXECUTE outcome.
//
// State projection: the pack's `requireReservationPresent` /
// `requireReservationCancellable` guards inspect `state.ctx.reservation`.
// The `confirmLastMinuteCancel` guard reads `state.ctx.slot` + `now` —
// we project the slot so the REQUEST_CONFIRMATION semantics apply for
// LLM-proposed cancels (the existing service.cancel() does no such check).
//
// ── BKL-242 — two entry points, so a conductor turn adjudicates ONCE ──────
//
// Same defect and same fix shape as BKL-232 (`reservation.modify`, PR #386).
// This tool has two callers, and only ONE of them has already adjudicated:
//
//   - `cancelReservation` (SELF-ADJUDICATING) — the REST `DELETE
//     /api/reservations/:id` route (apps/api/src/routes/reservations.ts),
//     which reaches the tool with no kernel decision behind it. It MUST mint
//     and adjudicate its own envelope or the mutation would run ungated
//     (CLAUDE.md rule #9).
//   - `cancelReservationPreAdjudicated` (BKL-242) — the claustrum tool
//     registry (apps/api/src/tools/register-ibatexas-tool-packs.ts). The
//     Conductor has ALREADY adjudicated this exact `reservation.cancel`
//     envelope through the audited kernel AND claimed its execution-ledger
//     key; re-minting a second envelope here produced a SECOND
//     `reservation.cancel` EXECUTE per single customer confirm (live
//     intent_audit pair 6712/6714, turn_trace 1dc9a6b8 — one turn, two
//     EXECUTE rows 5.23s apart).
//
// Why the execution ledger could not absorb the duplicate: it dedups on
// `intentHash` (`ledger:intent:<hash>`, SET NX), and the envelope minted below
// is a DIFFERENT envelope from the Conductor's — fresh `nonce: randomUUID()`,
// a payload without `customerId`, and `actor.sessionId = customer:<id>` rather
// than the conversation session — so its hash can never collide with the
// adjudicated one, and `withAdjudicate` is wired with no ledger at all.
//
// Write-time invariants are unaffected on the pre-adjudicated path:
// `reservationService.cancel` re-reads the reservation and re-asserts ownership
// + mutability inside its own transaction (reservation.service.ts) — the pack
// guards the Conductor already ran are advisory reads. `svc.getById` is kept on
// BOTH paths: it is not state projection, it supplies the slot date + start time
// that `sendReservationCancelled` needs AFTER the write (the row is still
// readable post-cancel, but reading it up front keeps one shape for both paths).
// Only the `timeSlot.findUnique` hydration — which exists solely to feed the
// kernel's `confirmLastMinuteCancel` guard — is skipped when the Conductor has
// already decided.

import { randomUUID } from "node:crypto"
import { createReservationService, prisma } from "@ibatexas/domain"
import { getAuditSink } from "@ibatexas/audit-sink"
import { CancelReservationInputSchema, type CancelReservationInput, type CancelReservationOutput } from "@ibatexas/types"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationCancelPayload,
  ReservationState,
} from "@ibatexas/pack-reservations"
import { withReservationOwnership } from "../guards/with-ownership.js"
import { notifyWaitlistSpotAvailable, sendReservationCancelled } from "./notifications.js"

/**
 * How the caller reached this tool — i.e. who owns the kernel decision.
 *
 * `"self"`      — nobody adjudicated yet; mint + adjudicate an envelope here.
 * `"conductor"` — the claustrum Conductor already adjudicated this intent and
 *                 claimed its execution-ledger key; execute, do NOT re-adjudicate
 *                 (BKL-242).
 */
type CancelAuthority = "self" | "conductor"

/**
 * The post-write side effects + pt-BR result, shared by both entry points so the
 * pre-adjudicated path cannot drift from the self-adjudicating one. The customer
 * notification and the NATS publish stay fire-and-forget (a delivery failure must
 * not fail a cancel that already committed); the waitlist promotion is awaited
 * exactly as before, because it is a second write.
 */
async function succeed(
  parsed: CancelReservationInput,
  reservationDetails: Awaited<ReturnType<ReturnType<typeof createReservationService>["getById"]>>,
  timeSlotId: string,
  svc: ReturnType<typeof createReservationService>,
): Promise<CancelReservationOutput> {
  // Notify customer of cancellation (fire-and-forget)
  void sendReservationCancelled(
    parsed.reservationId,
    reservationDetails.timeSlot.date,
    reservationDetails.timeSlot.startTime,
  ).catch((err) => console.error("[cancel_reservation] Notification error:", (err as Error).message))

  // Promote next waitlist entry and notify
  const { promoted } = await svc.promoteWaitlist(timeSlotId)
  if (promoted) {
    await notifyWaitlistSpotAvailable(
      {
        id: promoted.id,
        customerId: promoted.customerId,
        timeSlotId,
        partySize: promoted.partySize,
        position: 1,
        notifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      },
      promoted.date,
      promoted.startTime,
    )
  }

  void publishNatsEvent("reservation.cancelled", {
    eventType: "reservation.cancelled",
    customerId: parsed.customerId,
    sessionId: parsed.customerId,
    channel: "web",
    timestamp: new Date().toISOString(),
    metadata: {
      reservationId: parsed.reservationId,
      reason: parsed.reason ?? null,
    },
  }).catch((err) => console.error("[cancel_reservation] NATS publish error:", (err as Error).message))

  return {
    success: true,
    message: "Reserva cancelada com sucesso. Você receberá uma confirmação em breve.",
  }
}

// SEC-002: Ownership guard wrapper — rejects before any business logic
export const cancelReservation = withReservationOwnership(
  (input: CancelReservationInput) => cancelReservationImpl(input, "self"),
)

/**
 * BKL-242 — the entry point the claustrum tool registry dispatches on a kernel
 * EXECUTE. Identical to {@link cancelReservation} (same ownership guard, same
 * write, same notification + waitlist-promotion + NATS side effects, same pt-BR
 * result shape) except that it does NOT re-adjudicate: the Conductor's audited,
 * ledger-claimed decision is the single authorization for this mutation.
 */
export const cancelReservationPreAdjudicated = withReservationOwnership(
  (input: CancelReservationInput) => cancelReservationImpl(input, "conductor"),
)

async function cancelReservationImpl(
  input: CancelReservationInput,
  authority: CancelAuthority,
): Promise<CancelReservationOutput> {
  const parsed = CancelReservationInputSchema.parse(input)

  // BKL-046: thread the configured AuditSink so the kernel EXECUTE persists a
  // governance audit record — `createReservationService()` silently drops audit
  // emission when no sink is supplied (same idiom as create-reservation.ts).
  const svc = createReservationService({ auditSink: getAuditSink() })

  try {
    // Fetch reservation details before cancelling (for notification + state projection).
    // `getById` does its own ownership check; the result also feeds state below.
    const reservationDetails = await svc.getById(parsed.reservationId, parsed.customerId)

    // ── BKL-242 — the Conductor already authorized this intent ─────────
    // Execute the mutation under its decision. No second envelope, no second
    // adjudication, no second `reservation.cancel` EXECUTE audit row. The
    // slot hydration below exists only to feed a kernel run, so it is skipped
    // here too (it was a redundant read on this path).
    if (authority === "conductor") {
      const { timeSlotId } = await svc.cancel(parsed.reservationId, parsed.customerId)
      return succeed(parsed, reservationDetails, timeSlotId, svc)
    }

    // Hydrate the timeslot row for the last-minute-confirm guard.
    const slotRow = await prisma.timeSlot.findUnique({
      where: { id: reservationDetails.timeSlot.id },
    })

    const state: ReservationState = {
      ctx: {
        channel: "whatsapp",
        customerId: parsed.customerId,
        staffId: null,
        now: new Date(),
        reservation: {
          id: reservationDetails.id,
          status: reservationDetails.status as
            | "pending"
            | "confirmed"
            | "seated"
            | "completed"
            | "cancelled"
            | "no_show",
          partySize: reservationDetails.partySize,
          timeSlotId: reservationDetails.timeSlot.id,
        },
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

    // ── Build the IntentEnvelope ──────────────────────────────────────
    const payload: ReservationCancelPayload = {
      reservationId: parsed.reservationId,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    }
    const envelope = buildEnvelope<"reservation.cancel", ReservationCancelPayload>({
      kind: "reservation.cancel",
      payload,
      nonce: randomUUID(),
      actor: {
        principal: "llm",
        sessionId: `customer:${parsed.customerId}`,
      },
      taint: "UNTRUSTED",
    })

    const outcome = await svc.cancelFromEnvelope(envelope, state, {
      customerId: parsed.customerId,
    })

    if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
      let message: string
      if (outcome.decision.kind === "REFUSE") {
        message = outcome.decision.refusal.userFacing
      } else if (outcome.decision.kind === "REQUEST_CONFIRMATION") {
        message = outcome.decision.prompt
      } else {
        message = "Não foi possível cancelar a reserva no momento."
      }
      return {
        success: false,
        message,
      }
    }

    return succeed(parsed, reservationDetails, outcome.result!.timeSlotId, svc)
  } catch (err) {
    return {
      success: false,
      message: (err as Error).message,
    }
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const CancelReservationTool = {
  name: "cancel_reservation",
  description:
    "Cancela uma reserva existente. Só o titular pode cancelar. Notifica automaticamente o próximo na lista de espera, se houver.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "ID do cliente" },
      reservationId: { type: "string", description: "ID da reserva a cancelar" },
      reason: { type: "string", description: "Motivo do cancelamento (opcional)" },
    },
    required: ["customerId", "reservationId"],
  },
}
