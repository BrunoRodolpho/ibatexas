// No-show checker job
// Runs every 5 minutes via BullMQ repeatable job. Transitions confirmed
// reservations to `no_show` when the reserved time + 15 minutes has passed
// with no check-in.

import { createReservationService } from "@ibatexas/domain"
import { publishNatsEvent } from "@ibatexas/nats-client"
import * as Sentry from "@sentry/node"
import { createQueue, createWorker, type Job } from "./queue.js"
import type { Queue, Worker } from "bullmq"

const GRACE_PERIOD_MINUTES = Number.parseInt(process.env.NO_SHOW_GRACE_MINUTES || "15", 10)
const REPEAT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const RESTAURANT_TZ = process.env.RESTAURANT_TIMEZONE || "America/Chicago"

let queue: Queue | null = null
let worker: Worker | null = null

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
export async function checkNoShows(): Promise<void> {
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
      console.error(`[no-show] Invalid time data for reservation ${r.id}`)
      return false
    }
  })

  for (const reservation of noShows) {
    try {
      await svc.transition(reservation.id, "no_show")

      // Publish NATS event (fire-and-forget, outside transaction)
      await publishNatsEvent("reservation.no_show", {
        eventType: "reservation.no_show",
        customerId: reservation.customerId,
        sessionId: reservation.customerId,
        channel: "web",
        timestamp: new Date().toISOString(),
        metadata: { reservationId: reservation.id },
      })

      console.info(`[no-show] Reservation ${reservation.id} marked as no_show`)
    } catch (err) {
      console.error(`[no-show] Failed to process reservation ${reservation.id}:`, (err as Error).message)
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
export function startNoShowChecker(): void {
  if (worker) return // already running

  queue = createQueue("no-show-checker")
  worker = createWorker("no-show-checker", processor)

  worker.on("failed", (_job, err) => {
    console.error("[no-show] Check failed:", (err as Error).message)
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

  console.info("[no-show] Checker started (every 5 minutes)")
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
