// @ibatexas/types
// Shared TypeScript types across all apps and packages.

// Agent types
export type { AgentContext, AgentMessage, StreamChunk } from "./agent.types.js"
export { NonRetryableError } from "./agent.types.js"

// Admin types
export type {
  AdminDashboardMetrics,
  AdminProductRow,
  AdminProductDetail,
  AdminVariant,
  OrderSummary,
  MedusaOrderRaw,
} from "./admin.types.js"

export { mapMedusaOrderToSummary } from "./admin.types.js"

// Product types
export {
  AvailabilityWindow,
  ProductType,
  Channel,
  type UserType,
  type ProductStatus,
  type ProductDTO,
  type ProductVariant,
  type SearchProductsInput,
  type SearchProductsOutput,
  type ProductEmbedding,
  type QueryCacheEntry,
  type QueryLogEntry,
  type ProductViewedEvent,
  type ProductIndexedEvent,
  SearchProductsInputSchema,
} from "./product.types.js"

// Constants
export {
  MAX_PARTY_SIZE,
  SLOT_DURATION_MINUTES,
  SEED_DAYS_AHEAD,
  LUNCH_STARTS,
  DINNER_STARTS,
  SHIPPING_RATES,
  SHIPPING_RATE_DEFAULT,
  type ShippingRate,
} from "./constants.js"

// Cart types
export {
  AddToCartInputSchema,
  CancelOrderInputSchema,
  CheckOrderStatusInputSchema,
  CreateCheckoutInputSchema,
  GetCartInputSchema,
  GetOrCreateCartInputSchema,
  UpdateCartInputSchema,
  RemoveFromCartInputSchema,
  ReorderInputSchema,
  ApplyCouponInputSchema,
  GetOrderHistoryInputSchema,
  type AddToCartInput,
  type CancelOrderInput,
  CancelItemInputSchema,
  type CancelItemInput,
  AmendOrderInputSchema,
  type AmendOrderInput,
  type AmendOrderResult,
  type CheckOrderStatusInput,
  type CreateCheckoutInput,
  type GetCartInput,
  type UpdateCartInput,
  type RemoveFromCartInput,
  type ReorderInput,
  type ApplyCouponInput,
  type GetOrderHistoryInput,
  RegeneratePixInputSchema,
  type RegeneratePixInput,
} from "./cart.types.js"

// Intelligence types
export {
  GetCustomerProfileInputSchema,
  GetOrderedTogetherInputSchema,
  SubmitReviewInputSchema,
  UpdatePreferencesInputSchema,
  GetAlsoAddedInputSchema,
  type GetCustomerProfileInput,
  type GetOrderedTogetherInput,
  type SubmitReviewInput,
  type UpdatePreferencesInput,
  type GetAlsoAddedInput,
} from "./intelligence.types.js"

// Staff types
export {
  StaffRole,
  StaffSendOtpBody,
  StaffVerifyOtpBody,
  type StaffDTO,
  type StaffSendOtpInput,
  type StaffVerifyOtpInput,
} from "./staff.types.js"

// Order status
export {
  OrderFulfillmentStatus,
  canTransition,
  getNextStatus,
  ORDER_STATUS_LABELS_PT,
} from "./order-status.js"

// Order events (typed NATS event contracts)
export type {
  OrderEventItem,
  OrderActor,
  OrderPlacedEvent,
  OrderStatusChangedEvent,
  OrderCanceledEvent,
  OrderRefundedEvent,
  OrderDisputedEvent,
  OrderPaymentFailedEvent,
  PaymentStatusChangedEvent,
  PaymentMethodChangedEvent,
  OrderAmendChange,
  OrderAmendedEvent,
  OrderNoteAddedEvent,
  NotificationSendEvent,
} from "./order-events.js"

// Payment status
export {
  PaymentStatus,
  PaymentMethod,
  TERMINAL_PAYMENT_STATUSES,
  type TerminalPaymentStatus,
  isTerminalPaymentStatus,
  canTransitionPayment,
  PAYMENT_STATUS_LABELS_PT,
} from "./payment-status.js"

// Order type
export {
  OrderType,
  ORDER_TYPE_LABELS_PT,
} from "./order-type.js"

// Tool types (catalog + support)
export {
  CheckInventoryInputSchema,
  GetNutritionalInfoInputSchema,
  HandoffToHumanInputSchema,
  ScheduleFollowUpInputSchema,
  type CheckInventoryInput,
  type CheckInventoryOutput,
  type NutritionalInfo,
  type GetNutritionalInfoInput,
  type GetNutritionalInfoOutput,
  type HandoffToHumanInput,
  type HandoffToHumanOutput,
  type ScheduleFollowUpInput,
} from "./tools.js"

// Schedule types
export type {
  DaySchedule,
  HolidayEntry,
  TimeBlock,
  ScheduleOverrideEntry,
  RestaurantSchedule,
} from "./schedule.types.js"

// Reservation types
export {
  ReservationStatus,
  TableLocation,
  SpecialRequestType,
  SpecialRequestSchema,
  CheckAvailabilityInputSchema,
  CreateReservationInputSchema,
  ModifyReservationInputSchema,
  CancelReservationInputSchema,
  GetMyReservationsInputSchema,
  JoinWaitlistInputSchema,
  type SpecialRequest,
  type TimeSlotDTO,
  type TableDTO,
  type ReservationDTO,
  type WaitlistDTO,
  type AvailableSlot,
  type CheckAvailabilityInput,
  type CheckAvailabilityOutput,
  type CreateReservationInput,
  type CreateReservationOutput,
  type ModifyReservationInput,
  type ModifyReservationOutput,
  type CancelReservationInput,
  type CancelReservationOutput,
  type GetMyReservationsInput,
  type GetMyReservationsOutput,
  type JoinWaitlistInput,
  type JoinWaitlistOutput,
} from "./reservation.types.js"

// Format helpers
export { formatOrderId } from "./format.js"

// Payment method switch matrix
export { canSwitchPaymentMethod } from "./payment-method-matrix.js"

// Order action validator
export {
  canPerformAction,
  type CustomerAction,
  type ActionContext,
  type ActionResult,
} from "./order-action-validator.js"
