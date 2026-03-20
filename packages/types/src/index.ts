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
  UpdateCartInputSchema,
  RemoveFromCartInputSchema,
  ReorderInputSchema,
  ApplyCouponInputSchema,
  GetOrderHistoryInputSchema,
  type AddToCartInput,
  type CancelOrderInput,
  type CheckOrderStatusInput,
  type CreateCheckoutInput,
  type GetCartInput,
  type UpdateCartInput,
  type RemoveFromCartInput,
  type ReorderInput,
  type ApplyCouponInput,
  type GetOrderHistoryInput,
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
