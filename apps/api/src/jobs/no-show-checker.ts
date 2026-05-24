// No-show checker job
// Runs every 5 minutes via BullMQ repeatable job. Transitions confirmed
// reservations to `no_show` when the reserved time + 15 minutes has passed
// with no check-in.
//
// ── P1-J — kernel-gated transition via reservation.no_show.mark ─────────
//
// Previously called `svc.transition(reservation.id, "no_show")` directly —
// a deprecated bare-arg state-machine mutation that bypassed the kernel.
// The reservations Pack's taint policy marks `reservation.no_show.mark`
// SYSTEM-only; the BullMQ job is the legitimate system caller. We now
// build a system-actor envelope (nonce = `noshow:${reservationId}` for
// idempotency on retry) and call `transitionFromEnvelope`. REFUSE /
// non-EXECUTE outcomes are logged and skipped — the next tick re-attempts.

import { createReservationService } from "@ibatexas/domain"
import { publishNatsEvent } from "@ibatexas/nats-client"
import type {
  ReservationNoShowMarkPayload,
  ReservationState,
} from "@ibatexas/pack-reservations"
import * as Sentry from "@sentry/node"
import type { Queue, Worker } from "bullmq"
import type { FastifyBaseLogger } from "fastify"
import { createQueue, createWorker, type Job } from "./queue.js"
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js"

const GRACE_PERIOD_MINUTES = Number.parseInt(process.env.NO_SHOW_GRACE_MINUTES || "15", 10)
const REPEAT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const RESTAURANT_TZ = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"

let queue: Queue | null = null
let worker: Worker | null = null
let logger: FastifyBaseLogger | null = null

/**
 * Build a Date from a slot's date + startTime in the restaurant's timezone.
 */
function slotToLocalDate(date: Date, startTime: string): Date {
  const dateStr = date.toISOString().split("T")[0]
  const [hours, minutes] = startTime.split(":").map(Number)
  if (hours == null || minutes == null || Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new Error(`Invalid startTime format: ${startTime}`)
  }

  // Build a date at the slot's local time and compute TZ offset for comparison
  const local = new Date(`${dateStr}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`)
  const utcStr = local.toLocaleString("en-US", { timeZone: "UTC" })
  const tzStr = local.toLocaleString("en-US", { timeZone: RESTAURANT_TZ })
  const diff = new Date(utcStr).getTime() - new Date(tzStr).getTime()
  return new Date(local.getTime() + diff)
}

/** Core job logic — exported for direct testing. */
export async function checkNoShows(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger
  const now = new Date()

  // Only load confirmed reservations for today (not all historical ones)
  const todayStr = now.toISOString().split("T")[0]
  const todayDate = new Date(todayStr)
  const svc = createReservationService()
  const candidates = await svc.findConfirmedForDate(todayDate)

  const noShows = candidates.filter((r) => {
    try {
      const slotDate = slotToLocalDate(r.timeSlot.date, r.timeSlot.startTime)
      const graceEnd = new Date(slotDate.getTime() + GRACE_PERIOD_MINUTES * 60 * 1000)
      return now > graceEnd
    } catch {
      effectiveLogger?.error({ reservationId: r.id }, "[no-show] Invalid time data for reservation")
      return false
    }
  })

  for (const reservation of noShows) {
    try {
      // P1-J: kernel-gated transition. SYSTEM actor (taint=SYSTEM clears
      // the no_show.mark systemOnly floor). nonce keyed on reservationId
      // so re-runs across BullMQ ticks produce a deterministic intentHash
      // and the kernel / ledger can dedupe.
      const payload: ReservationNoShowMarkPayload = { reservationId: reservation.id }
      const envelope = buildSystemEnvelope<
        "reservation.no_show.mark",
        ReservationNoShowMarkPayload
      >({
        kind: "reservation.no_show.mark",
        payload,
        sourceSubject: "no-show-checker",
        eventId: `noshow:${reservation.id}`,
      })

      // Pack policy for no_show.mark requires the reservation snapshot in
      // state. System path → customerId/staffId nullable; we still project
      // them so the pack's "isAuthenticatedCustomer" guard short-circuits
      // (no_show.mark is not in CUSTOMER_FACING_MUTATIONS).
      const state = {
        ctx: {
          channel: "staff" as const,
          customerId: reservation.customerId,
          staffId: null,
          reservation: {
            id: reservation.id,
            status: reservation.status,
            partySize: reservation.partySize,
            timeSlotId: reservation.timeSlotId,
          },
        },
      } as ReservationState

      const outcome = await svc.transitionFromEnvelope(envelope, state)
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        effectiveLogger?.warn(
          {
            reservationId: reservation.id,
            decision: outcome.decision.kind,
            refusalCode:
              outcome.decision.kind === "REFUSE"
                ? outcome.decision.refusal.code
                : undefined,
          },
          "[no-show] kernel did not authorize no_show mark — skipping (next tick will retry)",
        )
        continue
      }

      // Publish NATS event (fire-and-forget, outside transaction)
      await publishNatsEvent("reservation.no_show", {
        eventType: "reservation.no_show",
        customerId: reservation.customerId,
        sessionId: reservation.customerId,
        channel: "web",
        timestamp: new Date().toISOString(),
        metadata: { reservationId: reservation.id },
      })

      effectiveLogger?.info({ reservationId: reservation.id }, "[no-show] Reservation marked as no_show")
    } catch (err) {
      effectiveLogger?.error({ reservationId: reservation.id, error: (err as Error).message }, "[no-show] Failed to process reservation")
      Sentry.withScope((scope) => {
        scope.setTag("job", "no-show-checker")
        scope.setTag("source", "background-job")
        scope.setContext("reservation", { reservationId: reservation.id })
        Sentry.captureException(err)
      })
    }
  }
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await checkNoShows()
}

/**
 * Start the no-show checker.
 * Call once from server.ts after the Fastify server is ready.
 */
export function startNoShowChecker(log?: FastifyBaseLogger): void {
  if (worker) return // already running
  logger = log ?? null

  queue = createQueue("no-show-checker")
  worker = createWorker("no-show-checker", processor)

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[no-show-checker] Unexpected error")
    Sentry.withScope((scope) => {
      scope.setTag("job", "no-show-checker")
      scope.setTag("source", "background-job")
      Sentry.captureException(err)
    })
  })

  // Add repeatable job + run immediately
  void queue.upsertJobScheduler("no-show-repeat", {
    every: REPEAT_INTERVAL_MS,
    immediately: true,
  })

  logger?.info("[no-show-checker] Checker started (every 5 minutes)")
}

/**
 * Stop the no-show checker.
 */
export async function stopNoShowChecker(): Promise<void> {
  if (worker) {
    await worker.close()
    worker = null
  }
  if (queue) {
    await queue.close()
    queue = null
  }
}
