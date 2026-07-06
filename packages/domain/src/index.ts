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
  INCIDENT_CAUSE_LABELS_PT,
  INCIDENT_SEVERITY_LABELS_PT,
  type IncidentIntentKind,
  type IncidentPayload,
  type IncidentOpenPayload,
  type IncidentClosePayload,
  type IncidentState,
} from "./services/__shared__/incident-policy.js"
// Ops-alert plane (NEW-025 detection half) — governed open/resolve + reads.
export {
  createOpsAlertService,
  maxSeverity,
  type OpsAlertService,
  type OpsAlertServiceOptions,
  type OpenOpsAlertResult,
  type OpsAlertListResult,
  type OpsAlertListParams,
} from "./services/ops-alert.service.js"
export {
  opsAlertPolicyBundle,
  opsAlertTaintPolicy,
  FROZEN_OPS_CAUSES,
  OPS_ALERT_CAUSE_LABELS_PT,
  OPS_ALERT_SEVERITY_LABELS_PT,
  type OpsAlertIntentKind,
  type OpsAlertPayload,
  type OpsAlertOpenPayload,
  type OpsAlertResolvePayload,
  type OpsAlertState,
} from "./services/__shared__/ops-alert-policy.js"
// AUT-038 + AUT-007 — OWNER-gated, kernel-governed staff-CRUD command plane
// (create / update / deactivate / role.assign). Read-only StaffService above is
// separate. HTTP-plane-only kinds — never LLM-proposable.
export {
  createStaffCommandService,
  actorStaffIdFromEnvelope,
  StaffNotFoundError,
  DuplicatePhoneError,
  LastOwnerError,
  SelfMutationError,
  StaffMutationConflictError,
  InvalidStaffPhoneError,
  InvalidStaffRoleError,
  InvalidHourlyRateError,
  RoleUpdateForbiddenError,
  type StaffCommandService,
  type StaffCommandServiceOptions,
  type StaffListParams,
  type StaffListResult,
} from "./services/staff-command.service.js"
export {
  staffCommandPolicyBundle,
  staffCommandTaintPolicy,
  STAFF_ROLE_VALUES,
  type StaffCommandIntentKind,
  type StaffCommandPayload,
  type StaffCreatePayload,
  type StaffUpdatePayload,
  type StaffDeactivatePayload,
  type StaffRoleAssignPayload,
  type StaffCommandState,
} from "./services/__shared__/staff-policy.js"
export {
  createTableService,
  type TableService,
  type TableServiceDeps,
  slotStartTimesFromHours,
  DuplicateTableNumberError,
  TableNotFoundError,
  TableHasFutureReservationsError,
} from "./services/table.service.js"
// NEW-016 staff scheduling (escala) — plain-CRUD assign + list-by-range + delete;
// NEW-034 extends the service with clock-in / clock-out.
export {
  createStaffScheduleService,
  type StaffScheduleService,
  type CreateShiftInput,
  type ListShiftsParams,
} from "./services/staff-schedule.service.js"
// NEW-034 labor-cost analytics — read-only scheduled/actual hours + cost aggregation.
export {
  createLaborCostService,
  type LaborCostService,
  type LaborCostParams,
  type StaffLaborCost,
  type LaborCostReport,
} from "./services/labor-cost.service.js"
export { createDeliveryZoneService, type DeliveryZoneService } from "./services/delivery-zone.service.js"
// NEW-003 raw-ingredient inventory (stock slice) — plain-CRUD + adjustStock +
// listLowStock; manager-gated at the route. NEW-036 adds `depleteStock` (the
// order-flow consume-with-shortfall primitive; the subscriber lives in apps/api).
export {
  createIngredientService,
  type IngredientService,
  type CreateIngredientInput,
  type UpdateIngredientPatch,
  type ListIngredientsParams,
  type DepleteStockResult,
} from "./services/ingredient.service.js"
// NEW-035 recipe/BOM + per-dish COGS (extends NEW-003) — plain-CRUD recipe (header +
// ingredient lines) + a COGS read; manager-gated at the route. The order-flow
// depletion subscriber is deferred (out of this slice).
export {
  createRecipeService,
  computeRecipeCogs,
  type RecipeService,
  type CreateRecipeInput,
  type RecipeLineInput,
  type RecipeWithLines,
  type CogsLine,
  type RecipeCogs,
} from "./services/recipe.service.js"
// NEW-005 daily specials / promo-of-the-day (ADMIN AUTHORING slice) — plain-CRUD
// create/list/getForDate/update/remove; manager-gated at the route. The customer-facing
// menu/web + chat surfacing (rides grounding/claims) is DEFERRED to NEW-038.
export {
  createDailySpecialService,
  type DailySpecialService,
  type CreateDailySpecialInput,
  type UpdateDailySpecialPatch,
  type ListDailySpecialsParams,
} from "./services/daily-special.service.js"
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

// Caixa / day-close reconciliation (NEW-011) — read-only aggregation service.
export {
  createDayCloseService,
  type DayCloseService,
  type DaySummary,
  type DayCloseMethodTotals,
} from "./services/day-close.service.js"

// Order analytics (NEW-013 + NEW-033) — read-only top-items + refund + margin aggregation.
export {
  createOrderAnalyticsService,
  type OrderAnalyticsService,
  type AnalyticsRange,
  type TopItem,
  type RefundAnalytics,
  type RefundTrendPoint,
  type MarginRow,
  type MarginTotals,
  type MarginsReport,
} from "./services/order-analytics.service.js"

// Kitchen ticket board (NEW-010, ticket-timing half) — read-only live board over
// the active (pre-delivery) orders: ticket age + time-in-status + queue depth.
// The pacing/throttle/capacity model is DEFERRED to NEW-039.
export {
  createKitchenService,
  type KitchenService,
  type KitchenBoard,
  type KitchenTicket,
  type QueueDepthEntry,
  type ActiveKitchenStatus,
} from "./services/kitchen.service.js"

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
  StaffShift,
  Ingredient,
  Recipe,
  RecipeIngredient,
  DailySpecial,
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
