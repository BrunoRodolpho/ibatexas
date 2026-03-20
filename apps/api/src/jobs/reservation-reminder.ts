// Reservation reminder job
// Runs once daily. Sends WhatsApp reminders to customers with confirmed
// reservations for today.
//
// Idempotent: uses Redis key rk("reminder:sent:{reservationId}") to prevent duplicates.

import { createReservationService, createCustomerService } from "@ibatexas/domain"
import { getRedisClient, rk, sendReservationReminder } from "@ibatexas/tools"
import { ReservationStatus, type ReservationDTO } from "@ibatexas/types"

const REMINDER_CHECK_HOUR = Number.parseInt(process.env.REMINDER_CHECK_HOUR || "9", 10)
const REMINDER_TTL_SECONDS = 24 * 60 * 60 // 24h — prevents re-sending on restart

let timeoutHandle: ReturnType<typeof setTimeout> | null = null

async function sendReminders(): Promise<void> {
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
      console.error(`[reservation-reminder] Failed to send reminder for ${reservation.id}:`, (err as Error).message)
    }
  }

  if (sent > 0) {
    console.info(`[reservation-reminder] Sent ${sent} reminders for ${todayStr}`)
  }
}

/**
 * Schedule daily reminder check.
 * Calculates ms until REMINDER_CHECK_HOUR today (or tomorrow if already past).
 */
export function startReservationReminder(): void {
  function scheduleNext(): void {
    const now = new Date()
    const target = new Date(now)
    target.setHours(REMINDER_CHECK_HOUR, 0, 0, 0)

    if (target <= now) {
      target.setDate(target.getDate() + 1) // already past today — schedule for tomorrow
    }

    const delay = target.getTime() - now.getTime()

    timeoutHandle = setTimeout(() => {
      void sendReminders().catch((err) => console.error("[reservation-reminder] Check failed:", (err as Error).message))
      scheduleNext() // re-schedule for next day
    }, delay)

    console.info(`[reservation-reminder] Next check at ${target.toISOString()} (in ${Math.round(delay / 60_000)} min)`)
  }

  // Also run immediately on startup to catch any missed reminders for today
  void sendReminders().catch((err) => console.error("[reservation-reminder] Initial check failed:", (err as Error).message))

  scheduleNext()
}

export function stopReservationReminder(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
}
