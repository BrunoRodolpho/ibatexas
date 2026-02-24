// No-show checker job
// Runs every 5 minutes. Transitions confirmed reservations to `no_show`
// when the reserved time + 15 minutes has passed with no check-in.
//
// Start this job in apps/api/src/server.ts after all routes are registered.

import { prisma } from "@ibatexas/domain"
import { publishNatsEvent } from "@ibatexas/nats-client"

const GRACE_PERIOD_MINUTES = 15
const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null

async function checkNoShows(): Promise<void> {
  const now = new Date()

  // Find confirmed reservations whose slot ended (start + grace) is in the past
  const candidates = await prisma.reservation.findMany({
    where: { status: "confirmed" },
    include: { timeSlot: true },
  })

  const noShows = candidates.filter((r) => {
    const [hours, minutes] = r.timeSlot.startTime.split(":").map(Number)
    const slotDate = new Date(r.timeSlot.date)
    slotDate.setUTCHours(hours!, minutes!, 0, 0)

    const graceEnd = new Date(slotDate.getTime() + GRACE_PERIOD_MINUTES * 60 * 1000)
    return now > graceEnd
  })

  for (const reservation of noShows) {
    try {
      // Mark as no_show + release covers and tables
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: "no_show" },
      })

      // Release covers
      await prisma.timeSlot.update({
        where: { id: reservation.timeSlotId },
        data: { reservedCovers: { decrement: reservation.partySize } },
      })

      // Release tables
      await prisma.reservationTable.deleteMany({
        where: { reservationId: reservation.id },
      })

      // Publish NATS event (fire-and-forget)
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
  checkNoShows().catch((err) => console.error("[no-show] Initial check failed:", err))

  intervalHandle = setInterval(() => {
    checkNoShows().catch((err) => console.error("[no-show] Check failed:", err))
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
