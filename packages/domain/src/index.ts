// @ibatexas/domain
// Exports the Prisma client singleton and re-exports generated Prisma types for convenience.

export { prisma } from "./client.js"

// Re-export Prisma types so consumers don't need to import from @prisma/client directly
export type {
  Table,
  TimeSlot,
  Reservation,
  ReservationTable,
  Waitlist,
  Review,
  TableLocation,
  ReservationStatus,
  Prisma,
} from "./generated/prisma-client/index.js"
