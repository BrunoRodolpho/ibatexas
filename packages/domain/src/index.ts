// @ibatexas/domain
// Exports the Prisma client singleton, domain services, and re-exports generated Prisma types.

export { prisma } from "./client.js"
export { claustrumMemoryPrisma } from "./claustrum-memory-client.js"

// Cross-repo raw DDL (non-Prisma table; see file header)
export { REMEDIATION_PROPOSALS_DDL } from "./remediation-proposals-ddl.js"

// Domain services
export {
  createReservationService,
  type ReservationService,
  type ReservationServiceOptions,
} from "./services/reservation.service.js"
export {
  createOrderService,
  type OrderService,
  type MedusaFetch,
  type AdminAdjudicated,
  type AdminAdjudicatedRequest,
  type OrderServiceOptions,
} from "./services/order.service.js"
export { getEffectivePonr, isWithinPonr, getItemPonrStatus, type PonrConfig, type ItemPonrStatus } from "./services/ponr.js"
export { toE164BR } from "./phone.js"
export {
  createCustomerService,
  type CustomerService,
  type CustomerServiceOptions,
  anonymizeCustomer,
  anonymizeCustomerFromEnvelope,
  exportCustomerData,
} from "./services/customer.service.js"
export { createStaffService, type StaffService } from "./services/staff.service.js"
export { assertOwnership, assertMutable } from "./services/shared.js"
export { createReviewService, type ReviewService } from "./services/review.service.js"
export {
  createConversationService,
  type ConversationService,
  type ConversationServiceOptions,
} from "./services/conversation.service.js"

// Conversation envelope surface — Task 15.
export {
  conversationPolicyBundle,
  conversationTaintPolicy,
  type ConversationIntentKind,
  type ConversationPayload,
  type ConversationState,
  type ConversationMessageAppendPayload,
  type ConversationDeletePayload,
  type ConversationDeleteAllPayload,
} from "./services/__shared__/conversation-policy.js"

// No-reply incident journal (W1) — governed open/close + reads.
export {
  createIncidentService,
  deriveSeverity,
  SEVERITY_AGING_THRESHOLD_MINUTES,
  type IncidentService,
  type IncidentServiceOptions,
  type OpenIncidentResult,
  type IncidentListResult,
  type IncidentListParams,
  type IncidentStats,
  type DeriveSeverityInput,
} from "./services/incident.service.js"
export {
  incidentPolicyBundle,
  incidentTaintPolicy,
  FROZEN_CAUSES,
  type IncidentIntentKind,
  type IncidentPayload,
  type IncidentOpenPayload,
  type IncidentClosePayload,
  type IncidentState,
} from "./services/__shared__/incident-policy.js"
export { createTableService, type TableService } from "./services/table.service.js"
export { createDeliveryZoneService, type DeliveryZoneService } from "./services/delivery-zone.service.js"
export { createLoyaltyService, type LoyaltyService, type LoyaltyServiceOptions } from "./services/loyalty.service.js"
export {
  loyaltyPolicyBundle,
  loyaltyTaintPolicy,
  type LoyaltyIntentKind,
  type LoyaltyPayload,
  type LoyaltyState,
  type LoyaltyStampAddPayload,
} from "./services/__shared__/loyalty-policy.js"
export {
  createScheduleService,
  type ScheduleService,
  type DaySchedule,
  type HolidayEntry,
  type RestaurantSchedule,
  DAY_NAMES,
} from "./services/schedule.service.js"

// Order projection services (CQRS)
export {
  createOrderCommandService,
  type OrderCommandService,
  type OrderCommandServiceOptions,
  type AddNoteResult,
  type SwitchTypeResult,
  type ChangeAddressResult,
  ConcurrencyError,
  ProjectionNotFoundError,
  InvalidTransitionError,
  MissingEventVersionError,
} from "./services/order-command.service.js"

// Envelope-typed surface — Task 15 (M3). Payload types for callers
// building IntentEnvelopes for the OrderCommandService envelope-typed
// methods. The Pack types (OrderNoteAddPayload, OrderIntentKind, etc.)
// are re-exported from @ibatexas/pack-orders directly; these are the
// domain-internal projection-lifecycle ones.
export {
  orderProjectionPolicyBundle,
  orderProjectionTaintPolicy,
  type OrderProjectionIntentKind,
  type OrderProjectionPayload,
  type OrderProjectionState,
  type OrderProjectionCreatePayload,
  type OrderStatusTransitionPayload,
  type OrderStatusReconcilePayload,
  type OrderTypeSwitchPayload,
  type OrderAddressChangePayload,
} from "./services/__shared__/order-projection-policy.js"

// Helper for callers that want to build their own envelope→service flows.
export {
  withAdjudicate,
  expectExecute,
  CommandRefusedError,
  type AdjudicatedResult,
  type WithAdjudicateOptions,
} from "./services/__shared__/with-adjudicate.js"
export {
  createOrderQueryService,
  type OrderQueryService,
} from "./services/order-query.service.js"
export {
  createOrderEventLogService,
  type OrderEventLogService,
  type AppendEventInput,
  type OrderEventLogRow,
} from "./services/order-event-log.service.js"

// Payment projection services (CQRS)
export {
  createPaymentCommandService,
  type PaymentCommandService,
  type PaymentCommandServiceOptions,
  type CreatePaymentInput,
  PaymentConcurrencyError,
  PaymentNotFoundError,
  InvalidPaymentTransitionError,
  ActivePaymentExistsError,
} from "./services/payment-command.service.js"

// Payment-projection policy + envelope types (Task 15 envelope surface).
export {
  paymentProjectionPolicyBundle,
  paymentProjectionTaintPolicy,
  getRefundConfirmThresholdCentavos,
  getRefundEscalateThresholdCentavos,
  getMaxPixRegenerationsPerPayment,
  type PaymentProjectionIntentKind,
  type PaymentProjectionPayload,
  type PaymentProjectionState,
  type PaymentCreatePayload,
  type PaymentStatusTransitionPayload,
  type PaymentStatusReconcilePayload,
  type PaymentMethodSwitchPayload,
  type PaymentRefundIssuePayload,
  type PaymentRegenerationCountIncrementPayload,
} from "./services/__shared__/payment-projection-policy.js"
export {
  createPaymentQueryService,
  type PaymentQueryService,
  type PaymentWithHistory,
} from "./services/payment-query.service.js"

// Medusa → domain mapper
export {
  toOrderProjectionData,
  toOrderEventItems,
  validateItemsSchema,
  ITEMS_SCHEMA_VERSION,
  type CreateOrderProjectionInput,
} from "./mappers/medusa-order.mapper.js"

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
  OrderProjection,
  OrderStatusHistory,
  OrderEventLog,
  Payment,
  PaymentStatusHistory,
  OrderNote,
  DeliveryZone,
  Staff,
  LoyaltyAccount,
  Conversation,
  ConversationMessage,
  ConversationIncident,
  IncidentKind,
  IncidentCause,
  IncidentSeverity,
  IncidentStatus,
  IncidentResolutionType,
  TableLocation,
  ReservationStatus,
  StaffRole,
  ConversationChannel,
  MessageRole,
  WeeklySchedule,
  Holiday,
  Prisma,
} from "./generated/prisma-client/client.js"

export type {
  OrderFulfillmentStatus as PrismaOrderFulfillmentStatus,
  OrderActor as PrismaOrderActor,
  PaymentStatus as PrismaPaymentStatus,
} from "./generated/prisma-client/client.js"
