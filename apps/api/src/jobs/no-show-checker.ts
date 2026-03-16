// No-show checker job
// Runs every 5 minutes. Transitions confirmed reservations to `no_show`
// when the reserved time + 15 minutes has passed with no check-in.
//
// Start this job in apps/api/src/server.ts after all routes are registered.

import { prisma } from "@ibatexas/domain"
import { publishNatsEvent } from "@ibatexas/nats-client"

const GRACE_PERIOD_MINUTES = Number.parseInt(process.env.NO_SHOW_GRACE_MINUTES || "15", 10)
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const RESTAURANT_TZ = process.env.RESTAURANT_TIMEZONE || "America/Chicago"

let intervalHandle: ReturnType<typeof setInterval> | null = null

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

async function checkNoShows(): Promise<void> {
  const now = new Date()

  // Only load confirmed reservations for today (not all historical ones)
  const todayStr = now.toISOString().split("T")[0]
  const todayDate = new Date(todayStr)
  const candidates = await prisma.reservation.findMany({
    where: {
      status: "confirmed",
      timeSlot: { date: todayDate },
    },
    include: { timeSlot: true },
  })

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
      // Wrap all mutations in a transaction to avoid partial updates
      await prisma.$transaction([
        prisma.reservation.update({
          where: { id: reservation.id },
          data: { status: "no_show" },
        }),
        prisma.timeSlot.update({
          where: { id: reservation.timeSlotId },
          data: { reservedCovers: { decrement: reservation.partySize } },
        }),
        prisma.reservationTable.deleteMany({
          where: { reservationId: reservation.id },
        }),
      ])

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
      console.error(`[no-show] Failed to process reservation ${reservation.id}:`, err)
    }
  }
}

/**
 * Start the no-show checker interval.
 * Call once from server.ts after the Fastify server is ready.
 */
export function startNoShowChecker(): void {
  if (intervalHandle) return // already running

  // Run immediately on startup to catch any missed transitions
  void checkNoShows().catch((err) => console.error("[no-show] Initial check failed:", err))

  intervalHandle = setInterval(() => {
    void checkNoShows().catch((err) => console.error("[no-show] Check failed:", err))
  }, CHECK_INTERVAL_MS)

  console.info("[no-show] Checker started (every 5 minutes)")
}

/**
 * Stop the no-show checker.
 */
export function stopNoShowChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
