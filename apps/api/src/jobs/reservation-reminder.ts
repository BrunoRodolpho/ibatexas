// Reservation reminder job
// Runs daily at a configurable hour via BullMQ repeatable job. Sends WhatsApp
// reminders to customers with confirmed reservations for today.
//
// Idempotent: uses Redis key rk("reminder:sent:{reservationId}") to prevent duplicates.

import { createReservationService, createCustomerService } from "@ibatexas/domain"
import { getRedisClient, rk, sendReservationReminder } from "@ibatexas/tools"
import * as Sentry from "@sentry/node"
import { ReservationStatus, type ReservationDTO } from "@ibatexas/types"
import type { Queue, Worker } from "bullmq"
import type { FastifyBaseLogger } from "fastify"
import { createQueue, createWorker, type Job } from "./queue.js"

const REMINDER_TTL_SECONDS = 24 * 60 * 60 // 24h — prevents re-sending on restart
const REPEAT_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

let queue: Queue | null = null
let worker: Worker | null = null
let logger: FastifyBaseLogger | null = null

/** Core job logic — exported for direct testing. */
export async function sendReminders(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger
  const today = new Date()
  const todayStr = today.toISOString().split("T")[0]
  const todayDate = new Date(todayStr)

  const svc = createReservationService()
  const candidates = await svc.findConfirmedForDate(todayDate)

  if (candidates.length === 0) return

  const redis = await getRedisClient()
  let sent = 0

  for (const reservation of candidates) {
    const idempotencyKey = rk(`reminder:sent:${reservation.id}`)
    const alreadySent = await redis.set(idempotencyKey, "1", { EX: REMINDER_TTL_SECONDS, NX: true })

    if (alreadySent !== "OK") continue // already sent today

    // Look up customer phone for WhatsApp notification
    try {
      const customerSvc = createCustomerService()
      const customer = await customerSvc.getById(reservation.customerId).catch(() => null)

      if (customer?.phone) {
        // Build a minimal DTO for the notification function
        const dto = {
          id: reservation.id,
          customerId: reservation.customerId,
          partySize: reservation.partySize,
          status: ReservationStatus.CONFIRMED,
          timeSlot: {
            id: reservation.timeSlot.id,
            date: todayStr,
            startTime: reservation.timeSlot.startTime,
            durationMinutes: reservation.timeSlot.durationMinutes,
          },
          tableLocation: null,
          specialRequests: [],
          confirmedAt: null,
          checkedInAt: null,
          cancelledAt: null,
          createdAt: reservation.createdAt.toISOString(),
          updatedAt: reservation.createdAt.toISOString(),
        } satisfies ReservationDTO

        await sendReservationReminder(dto, customer.phone)
        sent++
      }
    } catch (err) {
      effectiveLogger?.error({ reservationId: reservation.id, error: (err as Error).message }, "[reservation-reminder] Failed to send reminder")
      Sentry.withScope((scope) => {
        scope.setTag("job", "reservation-reminder")
        scope.setTag("source", "background-job")
        scope.setContext("reservation", { reservationId: reservation.id })
        Sentry.captureException(err)
      })
    }
  }

  if (sent > 0) {
    effectiveLogger?.info({ sent, date: todayStr }, "[reservation-reminder] Reminders sent")
  }
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await sendReminders()
}

/**
 * Schedule daily reminder check via BullMQ repeatable job.
 * Runs immediately on startup to catch any missed reminders for today,
 * then repeats every 24 hours.
 */
export function startReservationReminder(log?: FastifyBaseLogger): void {
  if (worker) return
  logger = log ?? null

  queue = createQueue("reservation-reminder")
  worker = createWorker("reservation-reminder", processor)

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[reservation-reminder] Unexpected error")
    Sentry.withScope((scope) => {
      scope.setTag("job", "reservation-reminder")
      scope.setTag("source", "background-job")
      Sentry.captureException(err)
    })
  })

  // Run immediately on startup + repeat every 24h
  void queue.upsertJobScheduler("reservation-reminder-repeat", {
    every: REPEAT_INTERVAL_MS,
    immediately: true,
  })

  logger?.info("[reservation-reminder] Job scheduler registered (every 24 hours)")
}

export async function stopReservationReminder(): Promise<void> {
  if (worker) {
    await worker.close()
    worker = null
  }
  if (queue) {
    await queue.close()
    queue = null
  }
}
