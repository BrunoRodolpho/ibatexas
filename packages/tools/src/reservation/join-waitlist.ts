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
//
// ── BKL-243 — two entry points, so a conductor turn adjudicates ONCE ──────
//
// Same defect and same fix shape as BKL-232 (`reservation.modify`, PR #386).
// This tool has two callers, and only ONE of them has already adjudicated:
//
//   - `joinWaitlist` (SELF-ADJUDICATING) — the REST `POST
//     /api/reservations/waitlist` route (apps/api/src/routes/reservations.ts),
//     which reaches the tool with no kernel decision behind it. It MUST mint
//     and adjudicate its own envelope or the mutation would run ungated
//     (CLAUDE.md rule #9).
//   - `joinWaitlistPreAdjudicated` (BKL-243) — the claustrum tool registry
//     (apps/api/src/tools/register-ibatexas-tool-packs.ts). The Conductor has
//     ALREADY adjudicated this exact `reservation.waitlist.join` envelope
//     through the audited kernel AND claimed its execution-ledger key;
//     re-minting a second envelope here adjudicated the same intent a second
//     time — a duplicate the ledger can never dedup, because the envelope built
//     below carries a fresh `nonce: randomUUID()` and a payload without
//     `customerId`, so its `intentHash` cannot collide.
//
// Write-time invariants are unaffected on the pre-adjudicated path: the
// slot-presence check and the already-waiting idempotency lookup both live
// inside `reservationService.joinWaitlist`, which runs on both paths.

import { randomUUID } from "node:crypto"
import { createReservationService } from "@ibatexas/domain"
import { getAuditSink } from "@ibatexas/audit-sink"
import { JoinWaitlistInputSchema, type JoinWaitlistInput, type JoinWaitlistOutput } from "@ibatexas/types"
import { buildEnvelope } from "@adjudicate/core"
import type {
  ReservationState,
  ReservationWaitlistJoinPayload,
} from "@ibatexas/pack-reservations"

/**
 * How the caller reached this tool — i.e. who owns the kernel decision.
 *
 * `"self"`      — nobody adjudicated yet; mint + adjudicate an envelope here.
 * `"conductor"` — the claustrum Conductor already adjudicated this intent and
 *                 claimed its execution-ledger key; execute, do NOT re-adjudicate
 *                 (BKL-243).
 */
type JoinWaitlistAuthority = "self" | "conductor"

/**
 * The pt-BR result, shared by both entry points so the pre-adjudicated path
 * cannot drift from the self-adjudicating one.
 */
function succeed(waitlistId: string, position: number): JoinWaitlistOutput {
  return {
    waitlistId,
    position,
    message: position === 1 && waitlistId
      ? `Você já está na lista de espera nesta posição: ${position}. Avisaremos pelo WhatsApp quando uma vaga abrir.`
      : `Você está na posição ${position} da lista de espera para este horário. Você será avisado pelo WhatsApp assim que uma vaga abrir.`,
  }
}

export function joinWaitlist(input: JoinWaitlistInput): Promise<JoinWaitlistOutput> {
  return joinWaitlistImpl(input, "self")
}

/**
 * BKL-243 — the entry point the claustrum tool registry dispatches on a kernel
 * EXECUTE. Identical to {@link joinWaitlist} (same write, same result shape)
 * except that it does NOT re-adjudicate: the Conductor's audited,
 * ledger-claimed decision is the single authorization for this mutation.
 */
export function joinWaitlistPreAdjudicated(
  input: JoinWaitlistInput,
): Promise<JoinWaitlistOutput> {
  return joinWaitlistImpl(input, "conductor")
}

async function joinWaitlistImpl(
  input: JoinWaitlistInput,
  authority: JoinWaitlistAuthority,
): Promise<JoinWaitlistOutput> {
  const parsed = JoinWaitlistInputSchema.parse(input)

  // BKL-046: thread the configured AuditSink so the kernel EXECUTE persists a
  // governance audit record — `createReservationService()` silently drops audit
  // emission when no sink is supplied (same idiom as create-reservation.ts).
  const svc = createReservationService({ auditSink: getAuditSink() })

  // ── BKL-243 — the Conductor already authorized this intent ─────────
  // Execute the mutation under its decision. No second envelope, no second
  // adjudication.
  if (authority === "conductor") {
    const { waitlistId, position } = await svc.joinWaitlist({
      customerId: parsed.customerId,
      timeSlotId: parsed.timeSlotId,
      partySize: parsed.partySize,
    })
    return succeed(waitlistId, position)
  }

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
  return succeed(waitlistId, position)
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
