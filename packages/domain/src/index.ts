// @ibatexas/domain
// Exports the Prisma client singleton, domain services, and re-exports generated Prisma types.

export { prisma } from "./client.js"

// Domain services
export { createReservationService, type ReservationService } from "./services/reservation.service.js"
export { createOrderService, type OrderService, type MedusaFetch } from "./services/order.service.js"
export { getEffectivePonr, isWithinPonr, getItemPonrStatus, type PonrConfig, type ItemPonrStatus } from "./services/ponr.js"
export { createCustomerService, type CustomerService, anonymizeCustomer, exportCustomerData } from "./services/customer.service.js"
export { createStaffService, type StaffService } from "./services/staff.service.js"
export { assertOwnership, assertMutable } from "./services/shared.js"
export { createReviewService, type ReviewService } from "./services/review.service.js"
export { createConversationService, type ConversationService } from "./services/conversation.service.js"
export { createTableService, type TableService } from "./services/table.service.js"
export { createDeliveryZoneService, type DeliveryZoneService } from "./services/delivery-zone.service.js"
export { createLoyaltyService, type LoyaltyService } from "./services/loyalty.service.js"
export {
  createScheduleService,
  type ScheduleService,
  type DaySchedule,
  type HolidayEntry,
  type RestaurantSchedule,
  DAY_NAMES,
} from "./services/schedule.service.js"

// Re-export Prisma types so consumers don't need to import from @prisma/client directly
export type {
  Table,
  TimeSlot,
  Reservation,
  ReservationTable,
  Waitlist,
  Review,
  Customer,
  Address,
  CustomerPreferences,
  CustomerOrderItem,
  DeliveryZone,
  Staff,
  LoyaltyAccount,
  Conversation,
  ConversationMessage,
  TableLocation,
  ReservationStatus,
  StaffRole,
  ConversationChannel,
  MessageRole,
  WeeklySchedule,
  Holiday,
  Prisma,
} from "./generated/prisma-client/client.js"
