/**
 * Shared FK-safe domain table cleanup (children first).
 */
import type { prisma as prismaInstance } from "@ibatexas/domain"

type PrismaInstance = typeof prismaInstance

export async function cleanDomainTables(prisma: PrismaInstance): Promise<void> {
  await prisma.reservationTable.deleteMany()
  await prisma.waitlist.deleteMany()
  await prisma.reservation.deleteMany()
  await prisma.review.deleteMany()
  await prisma.customerOrderItem.deleteMany()
  await prisma.address.deleteMany()
  await prisma.customerPreferences.deleteMany()
  await prisma.customer.deleteMany()
  await prisma.timeSlot.deleteMany()
  await prisma.table.deleteMany()
  await prisma.deliveryZone.deleteMany()
}
